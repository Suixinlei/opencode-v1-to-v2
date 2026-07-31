#!/usr/bin/env python3
"""Fail-closed production migration for supported mixed V1/V2 sessions."""

import argparse
import hashlib
import re
import shutil
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

import production_storage_migrate as base
from prepare_mixed_manifest import shape


def log(message):
    print(f"[production-mixed] {message}", flush=True)


def selected_state(path, session_ids):
    database = sqlite3.connect(
        f"{path.as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    placeholders = ",".join("?" for _ in session_ids)
    try:
        database.execute("PRAGMA query_only = ON")
        mixed = [
            row[0]
            for row in database.execute(
                """SELECT s.id
                   FROM session s
                   WHERE (
                     EXISTS (
                       SELECT 1 FROM message m WHERE m.session_id=s.id
                     )
                     OR EXISTS (
                       SELECT 1 FROM part p WHERE p.session_id=s.id
                     )
                   )
                     AND (
                       EXISTS (
                         SELECT 1 FROM event e
                         WHERE e.aggregate_id=s.id
                           AND e.type LIKE 'session.next.%'
                       )
                       OR EXISTS (
                         SELECT 1 FROM session_message sm
                         WHERE sm.session_id=s.id
                       )
                       OR EXISTS (
                         SELECT 1 FROM session_input si
                         WHERE si.session_id=s.id
                       )
                       OR EXISTS (
                         SELECT 1 FROM session_context_epoch ce
                         WHERE ce.session_id=s.id
                       )
                     )
                   ORDER BY s.id"""
            )
        ]
        selected = database.execute(
            f"""SELECT
                  COUNT(*) AS sessions,
                  COALESCE(SUM((
                    SELECT COUNT(*) FROM message m
                    WHERE m.session_id=s.id
                  )),0) AS legacy_messages,
                  COALESCE(SUM((
                    SELECT COUNT(*) FROM part p
                    WHERE p.session_id=s.id
                  )),0) AS legacy_parts
                FROM session s
                WHERE s.id IN ({placeholders})""",
            tuple(session_ids),
        ).fetchone()
        pending = database.execute(
            "SELECT COUNT(*) FROM session_input WHERE promoted_seq IS NULL"
        ).fetchone()[0]
        owned = database.execute(
            "SELECT COUNT(*) FROM event_sequence WHERE owner_id IS NOT NULL"
        ).fetchone()[0]
    finally:
        database.close()
    return {
        "mixedSessionIds": mixed,
        "selectedSessions": selected[0],
        "selectedLegacyMessages": selected[1],
        "selectedLegacyParts": selected[2],
        "pendingInputs": pending,
        "ownedAggregates": owned,
    }


def freeze_manifest(args, run_root):
    scan = base.remote_python(
        args.host,
        base.REMOTE / "scan_mixed_sessions.py",
    )
    captured_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    scan["capturedAt"] = captured_at
    base.write_json(run_root / "mixed-structural-scan.json", scan)
    if scan.get("errors"):
        raise RuntimeError("mixed structural scan contains database errors")

    requested = set(args.scope)
    grouped = defaultdict(list)
    for database in scan.get("databases", []):
        scope = f"{database['appCode']}/{database['userDir']}"
        if requested and scope not in requested:
            continue
        for session in database.get("sessions", []):
            classification = shape(session)
            if classification == "complex":
                raise RuntimeError(f"{scope}: unsupported complex mixed session")
            if (
                session.get("eventOwned") is not False
                or session.get("pendingInputs") != 0
            ):
                raise RuntimeError(f"{scope}: active mixed session state")
            grouped[scope].append(
                {
                    "sessionId": session["sessionId"],
                    "shape": classification,
                    "legacyMessages": session["legacyMessages"],
                    "legacyParts": session["legacyParts"],
                }
            )

    if requested:
        missing = requested - set(grouped)
        if missing:
            raise RuntimeError(
                f"requested scope is not a current mixed candidate: {sorted(missing)}"
            )
        grouped = {
            scope: sessions
            for scope, sessions in grouped.items()
            if scope in requested
        }
    entries = []
    for scope, sessions in sorted(grouped.items()):
        app_code, user_id = scope.split("/", 1)
        entries.append(
            {
                "scope": scope,
                "appCode": app_code,
                "userId": user_id,
                "path": (
                    f"/data/sandbox-storage/{app_code}/{user_id}"
                    "/opencode/opencode.db"
                ),
                "sessions": sorted(
                    sessions,
                    key=lambda item: item["sessionId"],
                ),
            }
        )
    if args.max_databases is not None:
        entries = entries[: args.max_databases]
    manifest = {
        "schemaVersion": 1,
        "capturedAt": captured_at,
        "sourceMutation": False,
        "excluded": [".bak", "workspace/.opencode"],
        "databaseCount": len(entries),
        "sessionCount": sum(len(entry["sessions"]) for entry in entries),
        "databases": entries,
    }
    base.write_json(run_root / "mixed-manifest.json", manifest)
    return entries


def run_cli(arguments):
    base.run_migration_cli(arguments)


def delete_known_temporaries(host, paths):
    existing = []
    for path in paths:
        if not path:
            continue
        item = base.temp_files(host, "inspect", path)["files"][0]
        if item.get("state") == "present":
            existing.append((path, item["sha256"]))
    if existing:
        return base.cleanup_remote_temporaries(host, existing)
    return {"ok": True, "operation": "delete", "files": []}


def reconcile_and_restore_original(
    *,
    host,
    controller_base,
    app_code,
    user_id,
    live_path,
    original_remote_path,
    original_hash,
    migrated_hash,
    clean_hash,
):
    base.ensure_stopped(controller_base, app_code, user_id)
    live = base.checkpoint(host, live_path)
    original = base.temp_files(
        host,
        "inspect",
        original_remote_path,
    )["files"][0]
    if live["sha256"] == original_hash:
        return {
            "state": "already-original",
            "liveCheckpoint": live,
            "originalTemporary": original,
        }
    if (
        live["sha256"] not in {migrated_hash, clean_hash}
        or original.get("state") != "present"
        or original.get("sha256") != original_hash
    ):
        raise RuntimeError("cannot reconcile unknown publish outcome")
    swap = base.atomic_swap(
        host,
        live_path,
        original_remote_path,
        live["sha256"],
        original_hash,
    )
    restored = base.checkpoint(host, live_path)
    if restored["sha256"] != original_hash:
        raise RuntimeError("reconciled rollback hash verification failed")
    return {
        "state": "restored-by-swap",
        "liveCheckpoint": live,
        "swap": swap,
        "restoredCheckpoint": restored,
    }


def process_database(args, run_root, entry):
    scope = entry["scope"]
    app_code = entry["appCode"]
    user_id = entry["userId"]
    live_path = entry["path"]
    session_ids = [item["sessionId"] for item in entry["sessions"]]
    expected_shapes = {
        item["sessionId"]: item["shape"] for item in entry["sessions"]
    }
    scope_dir = base.private_directory(
        run_root / "databases" / app_code / user_id
    )
    complete_path = scope_dir / "complete.json"
    if complete_path.exists():
        return base.read_json(complete_path)
    if (
        not base.CANONICAL.fullmatch(live_path)
        or user_id.endswith(".bak")
        or not base.SAFE_SCOPE.fullmatch(app_code)
        or not base.SAFE_SCOPE.fullmatch(user_id)
    ):
        raise RuntimeError(f"{scope}: invalid canonical scope")

    state = {
        "schemaVersion": 1,
        "scope": scope,
        "phase": "starting",
        "livePath": live_path,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    base.write_json(scope_dir / "state.json", state)
    lock_token = hashlib.sha256(
        f"mixed\0{args.run_id}\0{scope}".encode()
    ).hexdigest()
    lock_acquired = False
    was_running = False
    published_phase = "none"
    original_remote_path = ""
    clean_remote_path = ""
    original_hash = ""
    migrated_hash = ""
    clean_hash = ""
    rollback_succeeded = False

    try:
        lock = base.migration_lock(
            args.host,
            "acquire",
            live_path,
            lock_token,
        )
        lock_acquired = True
        base.write_json(scope_dir / "migration-lock-acquire.json", lock)
        initial_status, stopped_status = base.ensure_stopped(
            args.controller_base,
            app_code,
            user_id,
        )
        was_running = initial_status["state"].lower() == "running"
        state.update(
            {
                "phase": "stopped",
                "initialSandboxStatus": initial_status,
                "stoppedSandboxStatus": stopped_status,
            }
        )
        base.write_json(scope_dir / "state.json", state)

        checkpoint = base.checkpoint(args.host, live_path)
        base.write_json(scope_dir / "checkpoint.json", checkpoint)
        original_hash = checkpoint["sha256"]
        backup = (
            base.private_directory(scope_dir / "backup") / "opencode.db"
        )
        base.scp_from(args.host, live_path, backup)
        if base.sha256(backup) != original_hash:
            raise RuntimeError("downloaded backup hash mismatch")
        base.local_database_checks(backup)
        source_state = selected_state(backup, session_ids)
        if (
            source_state["mixedSessionIds"] != sorted(session_ids)
            or source_state["selectedSessions"] != len(session_ids)
            or source_state["pendingInputs"] != 0
            or source_state["ownedAggregates"] != 0
        ):
            raise RuntimeError("checkpointed mixed state changed from manifest")
        base.write_json(scope_dir / "source-state.json", source_state)

        inventory_dir = base.private_directory(scope_dir / "inventory")
        inventory_arguments = [
            "mixed-inventory",
            "--database",
            str(backup),
            "--run-dir",
            str(inventory_dir),
        ]
        for session_id in session_ids:
            inventory_arguments.extend(["--session", session_id])
        run_cli(inventory_arguments)
        plan_path = inventory_dir / "mixed-plan.json"
        plan = base.read_json(plan_path)
        planned = plan.get("sessions", [])
        if len(planned) != len(session_ids):
            raise RuntimeError("mixed plan target count changed")
        for session in planned:
            expected_shape = expected_shapes.get(session["sessionId"])
            planned_shape = session["shape"]
            cleanup_subtype = (
                expected_shape == "legacy-then-v2"
                and planned_shape == "v2-dual-write-cleanup"
            )
            if expected_shape != planned_shape and not cleanup_subtype:
                raise RuntimeError("mixed shape changed after checkpoint")

        candidate = (
            base.private_directory(scope_dir / "candidate") / "opencode.db"
        )
        migrate_dir = base.private_directory(scope_dir / "migrate")
        run_cli(
            [
                "mixed-migrate-local",
                "--database",
                str(backup),
                "--candidate",
                str(candidate),
                "--plan",
                str(plan_path),
                "--run-dir",
                str(migrate_dir),
                "--execute",
            ]
        )
        verification = base.read_json(
            migrate_dir / "mixed-verification.json"
        )
        if verification.get("verified") is not True:
            raise RuntimeError("local mixed migration verification failed")
        migrated_hash = base.sha256(candidate)

        clean = base.private_directory(scope_dir / "clean") / "opencode.db"
        shutil.copy2(candidate, clean)
        clean.chmod(0o600)
        cleanup_dir = base.private_directory(scope_dir / "cleanup")
        run_cli(
            [
                "mixed-cleanup-local",
                "--database",
                str(backup),
                "--candidate",
                str(clean),
                "--plan",
                str(plan_path),
                "--run-dir",
                str(cleanup_dir),
                "--execute",
            ]
        )
        cleanup_verification = base.read_json(
            cleanup_dir / "mixed-cleanup-verification.json"
        )
        if cleanup_verification.get("verified") is not True:
            raise RuntimeError("local mixed cleanup verification failed")
        cleanup_rerun = base.private_directory(scope_dir / "cleanup-rerun")
        run_cli(
            [
                "mixed-cleanup-local",
                "--database",
                str(backup),
                "--candidate",
                str(clean),
                "--plan",
                str(plan_path),
                "--run-dir",
                str(cleanup_rerun),
                "--execute",
            ]
        )
        clean_hash = base.sha256(clean)

        run_token = re.sub(r"[^A-Za-z0-9_.-]+", "-", args.run_id)
        remote_dir = str(Path(live_path).parent)
        original_remote_path = (
            f"{remote_dir}/.opencode.db.full-{run_token}.mixed"
        )
        clean_remote_path = (
            f"{remote_dir}/.opencode.db.full-{run_token}.mixed-clean"
        )
        base.upload_candidate(
            args.host,
            candidate,
            original_remote_path,
            migrated_hash,
        )
        base.upload_candidate(
            args.host,
            clean,
            clean_remote_path,
            clean_hash,
        )

        _, stopped_before_publish = base.ensure_stopped(
            args.controller_base,
            app_code,
            user_id,
        )
        before_publish = base.checkpoint(args.host, live_path)
        if before_publish["sha256"] != original_hash:
            raise RuntimeError("live database changed after backup")
        base.write_json(
            scope_dir / "prepublish-checkpoint.json",
            before_publish,
        )
        published_phase = "publishing-migrated"
        state["phase"] = published_phase
        base.write_json(scope_dir / "state.json", state)
        publish_migrated = base.atomic_swap(
            args.host,
            live_path,
            original_remote_path,
            original_hash,
            migrated_hash,
        )
        published_phase = "migrated"
        base.write_json(
            scope_dir / "publish-migrated.json",
            publish_migrated,
        )

        controller_classification = base.optional_controller_classification(
            args.controller_base,
            app_code,
            user_id,
        )
        started_for_acceptance = False
        if controller_classification is None:
            base.ensure_sandbox_running(
                args.controller_base,
                app_code,
                user_id,
            )
            started_for_acceptance = True
        acceptance = base.private_directory(scope_dir / "acceptance")
        before_cleanup = base.check_controller_messages(
            args.controller_base,
            app_code,
            user_id,
            acceptance / "messages-preclean.json",
            session_ids,
        )
        if before_cleanup.get("verified") is not True:
            raise RuntimeError("pre-clean messages acceptance failed")

        base.ensure_stopped(args.controller_base, app_code, user_id)
        migrated_checkpoint = base.checkpoint(args.host, live_path)
        if migrated_checkpoint["sha256"] != migrated_hash:
            raise RuntimeError("migrated live database changed")
        published_phase = "publishing-clean"
        state["phase"] = published_phase
        base.write_json(scope_dir / "state.json", state)
        publish_clean = base.atomic_swap(
            args.host,
            live_path,
            clean_remote_path,
            migrated_hash,
            clean_hash,
        )
        published_phase = "clean"
        base.write_json(scope_dir / "publish-clean.json", publish_clean)

        if started_for_acceptance:
            base.ensure_sandbox_running(
                args.controller_base,
                app_code,
                user_id,
            )
        after_cleanup = base.check_controller_messages(
            args.controller_base,
            app_code,
            user_id,
            acceptance / "messages-postclean.json",
            session_ids,
        )
        if after_cleanup.get("verified") is not True:
            raise RuntimeError("post-clean messages acceptance failed")

        base.ensure_stopped(args.controller_base, app_code, user_id)
        final_checkpoint = base.checkpoint(args.host, live_path)
        if final_checkpoint["sha256"] != clean_hash:
            raise RuntimeError("final live hash differs from clean candidate")
        final_dir = base.private_directory(scope_dir / "final")
        base.write_json(final_dir / "checkpoint.json", final_checkpoint)
        final_backup = (
            base.private_directory(final_dir / "backup") / "opencode.db"
        )
        base.scp_from(args.host, live_path, final_backup)
        if base.sha256(final_backup) != clean_hash:
            raise RuntimeError("final downloaded database hash mismatch")
        base.local_database_checks(final_backup)
        final_state = selected_state(final_backup, session_ids)
        if (
            final_state["mixedSessionIds"]
            or final_state["selectedLegacyMessages"] != 0
            or final_state["selectedLegacyParts"] != 0
            or final_state["pendingInputs"] != 0
            or final_state["ownedAggregates"] != 0
        ):
            raise RuntimeError("final mixed cleanup state failed")
        base.write_json(final_dir / "source-state.json", final_state)
        published_phase = "accepted"

        cleanup_remote = base.cleanup_remote_temporaries(
            args.host,
            [
                (original_remote_path, original_hash),
                (clean_remote_path, migrated_hash),
            ],
        )
        base.write_json(
            final_dir / "remote-temp-cleanup.json",
            cleanup_remote,
        )
        if was_running:
            restored_status = base.ensure_sandbox_running(
                args.controller_base,
                app_code,
                user_id,
            )
        else:
            restored_status = base.controller_status(
                args.controller_base,
                app_code,
                user_id,
            )
        release = base.migration_lock(
            args.host,
            "release",
            live_path,
            lock_token,
        )
        lock_acquired = False
        base.write_json(scope_dir / "migration-lock-release.json", release)
        complete = {
            "schemaVersion": 1,
            "scope": scope,
            "status": "complete",
            "targetSessions": len(session_ids),
            "originalSha256": original_hash,
            "migratedSha256": migrated_hash,
            "finalSha256": clean_hash,
            "messagesPrecleanVerified": True,
            "messagesPostcleanVerified": True,
            "startedForAcceptance": started_for_acceptance,
            "restoredSandboxStatus": restored_status,
            "exclusiveMigrationLockVerified": True,
            "completedAt": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ",
                time.gmtime(),
            ),
        }
        base.write_json(complete_path, complete)
        state["phase"] = "complete"
        base.write_json(scope_dir / "state.json", state)
        log(f"{scope}: complete; migrated {len(session_ids)} mixed session(s)")
        return complete
    except Exception as error:
        failure = {
            "schemaVersion": 1,
            "scope": scope,
            "phase": published_phase,
            "errorType": type(error).__name__,
            "error": str(error),
            "rollbackAttempted": False,
            "rollbackSucceeded": False,
            "failedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if published_phase in {
            "publishing-migrated",
            "migrated",
            "publishing-clean",
            "clean",
        }:
            failure["rollbackAttempted"] = True
            try:
                rollback = reconcile_and_restore_original(
                    host=args.host,
                    controller_base=args.controller_base,
                    app_code=app_code,
                    user_id=user_id,
                    live_path=live_path,
                    original_remote_path=original_remote_path,
                    original_hash=original_hash,
                    migrated_hash=migrated_hash,
                    clean_hash=clean_hash,
                )
                base.write_json(scope_dir / "rollback.json", rollback)
                rollback_succeeded = True
                failure["rollbackSucceeded"] = True
            except Exception as rollback_error:
                failure["rollbackErrorType"] = type(rollback_error).__name__
                failure["rollbackError"] = str(rollback_error)
        if published_phase == "none" or rollback_succeeded:
            try:
                temporary_cleanup = delete_known_temporaries(
                    args.host,
                    [original_remote_path, clean_remote_path],
                )
                base.write_json(
                    scope_dir / "failure-temp-cleanup.json",
                    temporary_cleanup,
                )
            except Exception as cleanup_error:
                failure["tempCleanupErrorType"] = type(cleanup_error).__name__
                failure["tempCleanupError"] = str(cleanup_error)
        try:
            if was_running:
                base.ensure_sandbox_running(
                    args.controller_base,
                    app_code,
                    user_id,
                )
        except Exception as restore_error:
            failure["restoreErrorType"] = type(restore_error).__name__
            failure["restoreError"] = str(restore_error)
        if lock_acquired:
            try:
                base.migration_lock(
                    args.host,
                    "release",
                    live_path,
                    lock_token,
                )
                lock_acquired = False
                failure["lockReleaseSucceeded"] = True
            except Exception as lock_error:
                failure["lockReleaseSucceeded"] = False
                failure["lockReleaseErrorType"] = type(lock_error).__name__
                failure["lockReleaseError"] = str(lock_error)
        base.write_json(scope_dir / "failure.json", failure)
        state["phase"] = "failed"
        base.write_json(scope_dir / "state.json", state)
        raise


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--controller-base", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--scope", action="append", default=[])
    parser.add_argument("--max-databases", type=int)
    parser.add_argument("--execute", action="store_true")
    return parser.parse_args()


def main():
    args = parse_arguments()
    if not args.execute:
        raise SystemExit("--execute is required")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.run_id):
        raise SystemExit("invalid --run-id")
    if args.max_databases is not None and args.max_databases < 1:
        raise SystemExit("--max-databases must be positive")
    run_root = base.private_directory(Path(args.run_dir).resolve())
    entries = freeze_manifest(args, run_root)
    if not entries:
        raise RuntimeError("no mixed session databases selected")
    log(
        f"selected {len(entries)} database(s), "
        f"{sum(len(entry['sessions']) for entry in entries)} mixed session(s)"
    )
    completed = []
    for entry in entries:
        completed.append(process_database(args, run_root, entry))
    report = {
        "schemaVersion": 1,
        "status": "complete",
        "databaseCount": len(completed),
        "migratedSessions": sum(
            item["targetSessions"] for item in completed
        ),
        "scopes": [item["scope"] for item in completed],
        "completedAt": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ",
            time.gmtime(),
        ),
    }
    base.write_json(run_root / "batch-complete.json", report)
    log("batch complete")


if __name__ == "__main__":
    main()
