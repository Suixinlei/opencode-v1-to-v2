#!/usr/bin/env python3
"""Fail-closed production batch orchestration for canonical OpenCode databases.

The script deliberately keeps remote lifecycle operations outside the migration
recipe. Each database is isolated: stop/absence gate, checkpoint, local
rollback backup, pinned official replay, clean-copy continuation proof, two
hash-locked atomic publishes, controller message verification, final download,
and remote temporary cleanup.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
REMOTE = REPO / "ops" / "remote"
VERIFY_MESSAGES = REPO / "ops" / "verify-controller-messages.ts"
CHECK_MESSAGES = REPO / "ops" / "check-controller-messages.ts"
CANONICAL = re.compile(
    r"^/data/sandbox-storage/([^/]+)/([^/]+)/opencode/opencode\.db$"
)
SAFE_SCOPE = re.compile(r"^[A-Za-z0-9_-]+$")
CLASSIFICATION_SQL = """WITH flags AS (
  SELECT s.id,
    CASE WHEN
      EXISTS (SELECT 1 FROM message m WHERE m.session_id=s.id)
      OR EXISTS (SELECT 1 FROM part p WHERE p.session_id=s.id)
    THEN 1 ELSE 0 END AS legacy,
    CASE WHEN
      EXISTS (
        SELECT 1 FROM event e
        WHERE e.aggregate_id=s.id AND e.type LIKE 'session.next.%'
      )
      OR EXISTS (
        SELECT 1 FROM session_message sm WHERE sm.session_id=s.id
      )
      OR EXISTS (
        SELECT 1 FROM session_input si WHERE si.session_id=s.id
      )
      OR EXISTS (
        SELECT 1 FROM session_context_epoch ce WHERE ce.session_id=s.id
      )
    THEN 1 ELSE 0 END AS v2
  FROM session s
)
SELECT
  COUNT(*) AS sessions,
  COALESCE(SUM(CASE WHEN legacy=1 AND v2=0 THEN 1 ELSE 0 END),0)
    AS legacy_only,
  COALESCE(SUM(CASE WHEN legacy=1 AND v2=1 THEN 1 ELSE 0 END),0)
    AS legacy_and_v2,
  (SELECT COUNT(*) FROM message) AS legacy_messages,
  (SELECT COUNT(*) FROM part) AS legacy_parts,
  (SELECT COUNT(*) FROM session_input WHERE promoted_seq IS NULL)
    AS pending_inputs,
  (SELECT COUNT(*) FROM event_sequence WHERE owner_id IS NOT NULL)
    AS owned_aggregates
FROM flags"""


class CommandFailure(RuntimeError):
    pass


def log(message):
    print(f"[production-storage] {message}", flush=True)


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def write_json(path, value):
    private_directory(path.parent)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def write_json_exclusive(path, value):
    private_directory(path.parent)
    payload = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n"
    ).encode()
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        written = os.write(descriptor, payload)
        if written != len(payload):
            raise RuntimeError("short write for exclusive JSON file")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def read_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run(command, *, stdin=None, cwd=REPO, allow_failure=False):
    process = subprocess.run(
        [str(value) for value in command],
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
    )
    if process.returncode != 0 and not allow_failure:
        stderr = process.stderr.strip()
        stdout = process.stdout.strip()
        detail = stderr or stdout or "no output"
        raise CommandFailure(
            f"{Path(str(command[0])).name} exited {process.returncode}: "
            f"{detail[-4000:]}"
        )
    return process


def remote_python(host, script, *arguments):
    source = script.read_text(encoding="utf-8")
    process = run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            host,
            "python3",
            "-",
            *arguments,
        ],
        stdin=source,
    )
    try:
        return json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"invalid remote JSON from {script.name}") from error


def scp_from(host, remote_path, local_path):
    private_directory(local_path.parent)
    run(
        [
            "scp",
            "-p",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            f"{host}:{remote_path}",
            str(local_path),
        ]
    )
    local_path.chmod(0o600)


def scp_to(host, local_path, remote_path):
    run(
        [
            "scp",
            "-p",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            str(local_path),
            f"{host}:{remote_path}",
        ]
    )


def request_json(url, *, method="GET", body=None, not_found_none=False):
    encoded = None
    headers = {}
    if body is not None:
        encoded = json.dumps(body, separators=(",", ":")).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url,
        data=encoded,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if not_found_none and error.code == 404:
            return None
        raise RuntimeError(f"HTTP {error.code}: {urllib.parse.urlsplit(url).path}")


def controller_status(base, app_code, user_id):
    query = urllib.parse.urlencode({"appCode": app_code, "userId": user_id})
    payload = request_json(
        f"{base}/api/v1/sandbox/status?{query}",
        not_found_none=True,
    )
    if payload is None:
        return {"exists": False, "state": "Missing"}
    if payload.get("success") is not True or not isinstance(payload.get("data"), dict):
        raise RuntimeError("invalid sandbox status response")
    data = payload["data"]
    return {
        "exists": True,
        "state": str(data.get("state") or "Unknown"),
        "startedAt": data.get("started_at"),
    }


def stop_sandbox(base, app_code, user_id):
    query = urllib.parse.urlencode({"appCode": app_code, "userId": user_id})
    payload = request_json(
        f"{base}/api/v1/sandbox/idle?{query}",
        method="POST",
    )
    if payload.get("success") is not True:
        raise RuntimeError("sandbox idle request failed")


def ensure_sandbox_running(base, app_code, user_id):
    payload = request_json(
        f"{base}/api/v1/sandbox",
        method="POST",
        body={"appCode": app_code, "userId": user_id},
    )
    if payload.get("success") is not True:
        raise RuntimeError("sandbox restore request failed")
    deadline = time.time() + 180
    while time.time() < deadline:
        status = controller_status(base, app_code, user_id)
        if status["state"].lower() == "running":
            return status
        time.sleep(2)
    raise RuntimeError("sandbox did not return to Running")


def ensure_stopped(base, app_code, user_id):
    initial = controller_status(base, app_code, user_id)
    state = initial["state"].lower()
    if state == "running":
        stop_sandbox(base, app_code, user_id)
    elif state not in {"missing", "idle", "failed", "stopped"}:
        deadline = time.time() + 120
        while time.time() < deadline:
            current = controller_status(base, app_code, user_id)
            state = current["state"].lower()
            if state == "running":
                stop_sandbox(base, app_code, user_id)
                break
            if state in {"missing", "idle", "failed", "stopped"}:
                break
            time.sleep(2)
        else:
            raise RuntimeError("sandbox did not reach a stoppable state")

    deadline = time.time() + 180
    while time.time() < deadline:
        current = controller_status(base, app_code, user_id)
        if current["state"].lower() in {"missing", "idle", "failed", "stopped"}:
            return initial, current
        time.sleep(2)
    raise RuntimeError("sandbox did not stop")


def controller_query(base, app_code, user_id, sql):
    payload = request_json(
        f"{base}/api/v1/sessions/query",
        method="POST",
        body={"appCode": app_code, "userId": user_id, "sql": sql},
    )
    if payload.get("success") is not True:
        raise RuntimeError("controller query failed")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("controller query returned invalid data")
    return data


def current_classification(base, app_code, user_id):
    data = controller_query(base, app_code, user_id, CLASSIFICATION_SQL)
    columns = data.get("columns")
    rows = data.get("rows")
    if not isinstance(columns, list) or not isinstance(rows, list) or len(rows) != 1:
        raise RuntimeError("invalid classification response")
    if not isinstance(rows[0], list) or len(columns) != len(rows[0]):
        raise RuntimeError("classification columns and values differ")
    return dict(zip(columns, rows[0]))


def optional_controller_classification(base, app_code, user_id):
    try:
        return current_classification(base, app_code, user_id)
    except RuntimeError as error:
        if str(error) == "HTTP 400: /api/v1/sessions/query":
            return None
        raise


def local_classification(path):
    database = sqlite3.connect(
        f"{path.as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    try:
        database.execute("PRAGMA query_only = ON")
        cursor = database.execute(CLASSIFICATION_SQL)
        row = cursor.fetchone()
        columns = [description[0] for description in cursor.description]
    finally:
        database.close()
    if row is None or len(columns) != len(row):
        raise RuntimeError("invalid local classification result")
    return dict(zip(columns, row))


def assert_same_classification(left, right, context):
    keys = (
        "sessions",
        "legacy_only",
        "legacy_and_v2",
        "legacy_messages",
        "legacy_parts",
        "pending_inputs",
        "owned_aggregates",
    )
    differences = [
        key for key in keys if int(left[key]) != int(right[key])
    ]
    if differences:
        raise RuntimeError(
            f"{context} classification differs for {','.join(differences)}"
        )


def checkpoint(host, database_path):
    report = remote_python(
        host,
        REMOTE / "checkpoint_database.py",
        database_path,
    )
    if report.get("ok") is not True:
        raise RuntimeError("remote checkpoint failed")
    return report


def atomic_swap(host, live, candidate, live_hash, candidate_hash):
    report = remote_python(
        host,
        REMOTE / "atomic_swap.py",
        live,
        candidate,
        live_hash,
        candidate_hash,
    )
    if report.get("ok") is not True:
        raise RuntimeError("remote atomic swap failed")
    return report


def temp_files(host, operation, *paths):
    report = remote_python(
        host,
        REMOTE / "temp_files.py",
        operation,
        *paths,
    )
    if report.get("ok") is not True:
        raise RuntimeError("remote temporary-file operation failed")
    return report


def migration_lock(host, operation, database_path, token):
    report = remote_python(
        host,
        REMOTE / "migration_lock.py",
        operation,
        database_path,
        token,
    )
    if report.get("ok") is not True:
        raise RuntimeError(f"remote migration lock {operation} failed")
    return report


def upload_candidate(host, local_path, remote_path, expected_hash):
    inspected = temp_files(host, "inspect", remote_path)
    item = inspected["files"][0]
    if item["state"] == "absent":
        scp_to(host, local_path, remote_path)
        inspected = temp_files(host, "inspect", remote_path)
        item = inspected["files"][0]
    if item.get("state") != "present" or item.get("sha256") != expected_hash:
        raise RuntimeError("uploaded candidate hash mismatch")
    return item


def run_migration_cli(arguments):
    process = run(["bun", "run", "migrate", "--", *arguments])
    if process.stdout.strip():
        log(process.stdout.strip().splitlines()[-1])


def verify_controller_messages(
    database,
    controller_base,
    app_code,
    user_id,
    report,
    session_ids,
):
    process = run(
        [
            "bun",
            str(VERIFY_MESSAGES),
            str(database),
            controller_base,
            app_code,
            user_id,
            str(report),
            *session_ids,
        ]
    )
    payload = json.loads(process.stdout.strip().splitlines()[-1])
    if payload.get("verified") is not True:
        raise RuntimeError("controller message verification failed")
    return read_json(report)


def check_controller_messages(
    controller_base,
    app_code,
    user_id,
    report,
    session_ids,
):
    process = run(
        [
            "bun",
            str(CHECK_MESSAGES),
            controller_base,
            app_code,
            user_id,
            str(report),
            *session_ids,
        ]
    )
    payload = json.loads(process.stdout.strip().splitlines()[-1])
    if payload.get("verified") is not True:
        raise RuntimeError("controller structural message check failed")
    return read_json(report)


def derive_private_sentinel(database_path, session_ids):
    database = sqlite3.connect(
        f"{database_path.as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    assistant_fallback = None
    try:
        for session_id in session_ids:
            rows = database.execute(
                """SELECT m.data, p.data
                   FROM message m
                   JOIN part p ON p.message_id=m.id
                   WHERE m.session_id=?
                   ORDER BY m.time_created DESC, p.time_created DESC, p.id DESC""",
                (session_id,),
            )
            for message_raw, part_raw in rows:
                message = json.loads(message_raw)
                part = json.loads(part_raw)
                role = message.get("role")
                if role not in {"user", "assistant"} or part.get("type") != "text":
                    continue
                if part.get("ignored") is True or part.get("synthetic") is True:
                    continue
                text = part.get("text")
                if not isinstance(text, str):
                    continue
                text = unicodedata.normalize("NFC", text).strip()
                if len(text) >= 8:
                    candidate = (
                        session_id,
                        text[: min(32, len(text))],
                        role,
                    )
                    if role == "user":
                        return candidate
                    if assistant_fallback is None:
                        assistant_fallback = candidate
    finally:
        database.close()
    if assistant_fallback is not None:
        return assistant_fallback
    raise RuntimeError(
        "no legacy visible text is suitable for continuation proof"
    )


def global_pause_path(args):
    value = getattr(args, "global_pause_file", None)
    return Path(value) if value else None


def assert_global_not_paused(args, scope):
    path = global_pause_path(args)
    if path is not None and path.exists():
        raise RuntimeError(f"global migration pause is active before {scope}")


def signal_global_pause(args, scope, error):
    path = global_pause_path(args)
    if path is None or path.exists():
        return
    try:
        write_json_exclusive(
            path,
            {
                "schemaVersion": 1,
                "scope": scope,
                "errorType": type(error).__name__,
                "createdAt": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ",
                    time.gmtime(),
                ),
            },
        )
    except FileExistsError:
        return


def local_database_checks(path):
    database = sqlite3.connect(
        f"{path.as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    try:
        quick = [row[0] for row in database.execute("PRAGMA quick_check")]
        foreign_keys = list(database.execute("PRAGMA foreign_key_check"))
    finally:
        database.close()
    if quick != ["ok"] or foreign_keys:
        raise RuntimeError("local database integrity check failed")
    return {"quickCheck": quick, "foreignKeyViolations": len(foreign_keys)}


def cleanup_remote_temporaries(host, entries):
    arguments = [f"{path}={digest}" for path, digest in entries]
    return temp_files(host, "delete", *arguments)


def rollback_original(
    *,
    host,
    controller_base,
    app_code,
    user_id,
    live_path,
    original_remote_path,
    original_hash,
):
    ensure_stopped(controller_base, app_code, user_id)
    current = checkpoint(host, live_path)
    original = temp_files(host, "inspect", original_remote_path)["files"][0]
    if original.get("state") != "present" or original.get("sha256") != original_hash:
        raise RuntimeError("original rollback database is unavailable")
    report = atomic_swap(
        host,
        live_path,
        original_remote_path,
        current["sha256"],
        original_hash,
    )
    restored = checkpoint(host, live_path)
    if restored["sha256"] != original_hash:
        raise RuntimeError("rollback hash verification failed")
    return {"swap": report, "checkpoint": restored}


def process_database(args, run_root, database_entry):
    app_code = database_entry["appCode"]
    user_id = database_entry["userDir"]
    live_path = database_entry["path"]
    scope = f"{app_code}/{user_id}"
    scope_dir = private_directory(run_root / "databases" / app_code / user_id)
    complete_path = scope_dir / "complete.json"
    if complete_path.exists():
        log(f"{scope}: already complete in this run")
        return read_json(complete_path)

    match = CANONICAL.fullmatch(live_path)
    if (
        not match
        or match.group(1) != app_code
        or match.group(2) != user_id
        or user_id.endswith(".bak")
        or not SAFE_SCOPE.fullmatch(app_code)
        or not SAFE_SCOPE.fullmatch(user_id)
    ):
        raise RuntimeError(f"{scope}: invalid canonical scope")

    state = {
        "schemaVersion": 1,
        "scope": scope,
        "livePath": live_path,
        "phase": "starting",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    write_json(scope_dir / "state.json", state)
    was_running = False
    published_phase = "none"
    original_remote_path = ""
    clean_remote_path = ""
    original_hash = ""
    migrated_hash = ""
    clean_hash = ""
    accepted = False
    registered_for_acceptance = False
    started_for_acceptance = False
    controller_requires_running = False
    lock_token = hashlib.sha256(
        f"{args.run_id}\0{scope}\0{os.getpid()}".encode()
    ).hexdigest()
    lock_acquired = False

    try:
        lock_report = migration_lock(
            args.host,
            "acquire",
            live_path,
            lock_token,
        )
        lock_acquired = True
        write_json(scope_dir / "migration-lock-acquire.json", lock_report)
        log(
            f"{scope}: start; pureV1={database_entry['legacyOnly']} "
            f"sessions={database_entry['sessions']}"
        )
        initial_status, stopped_status = ensure_stopped(
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
        write_json(scope_dir / "state.json", state)

        checkpoint_report = checkpoint(args.host, live_path)
        write_json(scope_dir / "checkpoint.json", checkpoint_report)
        original_hash = checkpoint_report["sha256"]
        backup = private_directory(scope_dir / "backup") / "opencode.db"
        scp_from(args.host, live_path, backup)
        if sha256(backup) != original_hash:
            raise RuntimeError("downloaded backup hash mismatch")
        local_database_checks(backup)
        initial_classification = local_classification(backup)
        classification_mode = "checkpointed-backup"
        controller_classification = None
        if initial_status["exists"]:
            controller_classification = optional_controller_classification(
                args.controller_base,
                app_code,
                user_id,
            )
            if controller_classification is not None:
                assert_same_classification(
                    initial_classification,
                    controller_classification,
                    "preflight controller/backup",
                )
                classification_mode = "checkpointed-backup+controller"
        controller_requires_running = controller_classification is None
        if (
            initial_classification["legacy_only"] != database_entry["legacyOnly"]
            or initial_classification["pending_inputs"] != 0
            or initial_classification["owned_aggregates"] != 0
        ):
            raise RuntimeError("live classification changed since manifest")
        write_json(
            scope_dir / "preflight-classification.json",
            {
                **initial_classification,
                "verificationMode": classification_mode,
            },
        )
        state.update({"phase": "backed-up", "originalSha256": original_hash})
        write_json(scope_dir / "state.json", state)

        inventory_dir = private_directory(scope_dir / "inventory")
        run_migration_cli(
            [
                "inventory",
                "--database",
                str(backup),
                "--run-dir",
                str(inventory_dir),
            ]
        )
        plan_path = inventory_dir / "plan.json"
        plan = read_json(plan_path)
        sessions = plan.get("sessions", [])
        session_ids = [session["sessionId"] for session in sessions]
        if len(sessions) != database_entry["legacyOnly"]:
            raise RuntimeError("inventory target count differs from frozen manifest")
        blocked = [
            session["sessionId"]
            for session in sessions
            if session.get("state") not in {"eligible", "resumable"}
        ]
        if blocked:
            raise RuntimeError(f"migration plan blocked {len(blocked)} session(s)")

        candidate = private_directory(scope_dir / "candidate") / "opencode.db"
        migrate_dir = private_directory(scope_dir / "migrate")
        migrate_arguments = [
            "migrate-local",
            "--database",
            str(backup),
            "--candidate",
            str(candidate),
            "--plan",
            str(plan_path),
            "--run-dir",
            str(migrate_dir),
            *(["--direct-replay"] if args.structural_acceptance else []),
            "--execute",
        ]
        run_migration_cli(migrate_arguments)
        verification = read_json(migrate_dir / "verification.json")
        if verification.get("verified") is not True:
            raise RuntimeError("migration verification failed")
        if args.structural_acceptance:
            direct_replay = read_json(migrate_dir / "direct-replay.json")
            if (
                direct_replay.get("mode") != "direct-transaction"
                or direct_replay.get("sessions") != len(session_ids)
            ):
                raise RuntimeError("direct migration replay verification failed")
        else:
            replay = read_json(migrate_dir / "official-replay.json")
            if (
                len(replay.get("smoke", [])) != len(session_ids)
                or replay.get("version") != "1.18.9"
            ):
                raise RuntimeError("pinned migration replay verification failed")
        migrated_hash = sha256(candidate)

        clean = private_directory(scope_dir / "clean") / "opencode.db"
        shutil.copy2(candidate, clean)
        clean.chmod(0o600)
        cleanup_dir = private_directory(scope_dir / "cleanup")
        run_migration_cli(
            [
                "cleanup-local",
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
        cleanup_verification = read_json(cleanup_dir / "cleanup-verification.json")
        if cleanup_verification.get("verified") is not True:
            raise RuntimeError("cleanup verification failed")

        cleanup_rerun_dir = private_directory(scope_dir / "cleanup-rerun")
        run_migration_cli(
            [
                "cleanup-local",
                "--database",
                str(backup),
                "--candidate",
                str(clean),
                "--plan",
                str(plan_path),
                "--run-dir",
                str(cleanup_rerun_dir),
                "--execute",
            ]
        )
        cleanup_rerun = read_json(cleanup_rerun_dir / "cleanup-receipt.json")
        if cleanup_rerun.get("cleanup") != {
            "removedMessages": 0,
            "removedParts": 0,
            "sessions": 0,
        }:
            raise RuntimeError("cleanup rerun was not idempotent")

        idempotent_dir = private_directory(scope_dir / "migrate-after-clean")
        run_migration_cli(
            [
                "migrate-local",
                "--database",
                str(backup),
                "--candidate",
                str(clean),
                "--plan",
                str(plan_path),
                "--run-dir",
                str(idempotent_dir),
                *(["--direct-replay"] if args.structural_acceptance else []),
                "--execute",
            ]
        )
        idempotent_receipt = read_json(idempotent_dir / "receipt.json")
        if any(
            session.get("appendedEvents") != 0
            for session in idempotent_receipt.get("sessions", [])
        ):
            raise RuntimeError("post-clean migration rerun appended events")
        clean_hash = sha256(clean)

        if not args.structural_acceptance:
            proof_session, sentinel, sentinel_role = derive_private_sentinel(
                backup,
                session_ids,
            )
            proof_dir = private_directory(scope_dir / "continuation")
            proof_database = proof_dir / "opencode.db"
            shutil.copy2(clean, proof_database)
            proof_database.chmod(0o600)
            sentinel_path = proof_dir / "sentinel"
            with sentinel_path.open("x", encoding="utf-8") as handle:
                handle.write(sentinel)
                handle.flush()
                os.fsync(handle.fileno())
            sentinel_path.chmod(0o600)
            write_json(
                proof_dir / "source.json",
                {
                    "schemaVersion": 1,
                    "sessionId": proof_session,
                    "sourceRole": sentinel_role,
                    "unicodeLength": len(sentinel),
                    "digest": hashlib.sha256(sentinel.encode()).hexdigest(),
                },
            )
            try:
                run_migration_cli(
                    [
                        "prove-continuation-local",
                        "--database",
                        str(proof_database),
                        "--session",
                        proof_session,
                        "--sentinel-file",
                        str(sentinel_path),
                        "--run-dir",
                        str(proof_dir / "receipt"),
                        "--execute",
                    ]
                )
            finally:
                sentinel_path.unlink(missing_ok=True)
            proof = read_json(
                proof_dir / "receipt" / "continuation-proof.json"
            )
            if not all(
                proof.get(key) is True
                for key in (
                    "sameSession",
                    "oldContextReachedModel",
                    "newProbeReachedModel",
                    "assistantWritePersisted",
                    "restartReadbackPassed",
                    "noNewSessionCreated",
                )
            ):
                raise RuntimeError("same-session continuation proof failed")
            proof_database.unlink(missing_ok=True)
            Path(f"{proof_database}-wal").unlink(missing_ok=True)
            Path(f"{proof_database}-shm").unlink(missing_ok=True)

        assert_global_not_paused(args, scope)
        run_token = re.sub(r"[^A-Za-z0-9_.-]+", "-", args.run_id)
        remote_dir = str(Path(live_path).parent)
        original_remote_path = (
            f"{remote_dir}/.opencode.db.full-{run_token}.migrated"
        )
        clean_remote_path = f"{remote_dir}/.opencode.db.full-{run_token}.clean"
        upload_candidate(
            args.host,
            candidate,
            original_remote_path,
            migrated_hash,
        )
        upload_candidate(args.host, clean, clean_remote_path, clean_hash)

        _, stopped_before_publish = ensure_stopped(
            args.controller_base,
            app_code,
            user_id,
        )
        before_publish = checkpoint(args.host, live_path)
        if before_publish["sha256"] != original_hash:
            raise RuntimeError("live database changed after backup")
        write_json(scope_dir / "prepublish-checkpoint.json", before_publish)
        publish_migrated = atomic_swap(
            args.host,
            live_path,
            original_remote_path,
            original_hash,
            migrated_hash,
        )
        published_phase = "migrated"
        write_json(scope_dir / "publish-migrated.json", publish_migrated)

        if controller_requires_running:
            ensure_sandbox_running(
                args.controller_base,
                app_code,
                user_id,
            )
            started_for_acceptance = True
            registered_for_acceptance = not initial_status["exists"]
        acceptance_dir = private_directory(scope_dir / "acceptance")
        if args.structural_acceptance:
            preclean_messages = check_controller_messages(
                args.controller_base,
                app_code,
                user_id,
                acceptance_dir / "messages-preclean.json",
                session_ids,
            )
        else:
            preclean_messages = verify_controller_messages(
                candidate,
                args.controller_base,
                app_code,
                user_id,
                acceptance_dir / "messages-preclean.json",
                session_ids,
            )
        if preclean_messages.get("verified") is not True:
            raise RuntimeError("pre-clean messages are inconsistent")

        assert_global_not_paused(args, scope)
        _, stopped_before_clean = ensure_stopped(
            args.controller_base,
            app_code,
            user_id,
        )
        migrated_live = checkpoint(args.host, live_path)
        if migrated_live["sha256"] != migrated_hash:
            raise RuntimeError("migrated live database changed before cleanup")
        publish_clean = atomic_swap(
            args.host,
            live_path,
            clean_remote_path,
            migrated_hash,
            clean_hash,
        )
        published_phase = "clean"
        write_json(scope_dir / "publish-clean.json", publish_clean)

        if controller_requires_running:
            ensure_sandbox_running(
                args.controller_base,
                app_code,
                user_id,
            )
            started_for_acceptance = True
            registered_for_acceptance = not initial_status["exists"]
        if args.structural_acceptance:
            postclean_messages = check_controller_messages(
                args.controller_base,
                app_code,
                user_id,
                acceptance_dir / "messages-postclean.json",
                session_ids,
            )
        else:
            postclean_messages = verify_controller_messages(
                clean,
                args.controller_base,
                app_code,
                user_id,
                acceptance_dir / "messages-postclean.json",
                session_ids,
            )
        if postclean_messages.get("verified") is not True:
            raise RuntimeError("post-clean messages are inconsistent")

        assert_global_not_paused(args, scope)
        _, stopped_after_acceptance = ensure_stopped(
            args.controller_base,
            app_code,
            user_id,
        )
        write_json(
            scope_dir / "acceptance" / "stopped-after-postclean.json",
            stopped_after_acceptance,
        )
        final_checkpoint = checkpoint(args.host, live_path)
        if final_checkpoint["sha256"] != clean_hash:
            raise RuntimeError("final live hash differs from clean candidate")
        final_dir = private_directory(scope_dir / "final")
        write_json(final_dir / "checkpoint.json", final_checkpoint)
        final_backup = private_directory(final_dir / "backup") / "opencode.db"
        scp_from(args.host, live_path, final_backup)
        if sha256(final_backup) != clean_hash:
            raise RuntimeError("final downloaded database hash mismatch")
        local_database_checks(final_backup)
        final_inventory = private_directory(final_dir / "inventory")
        run_migration_cli(
            [
                "inventory",
                "--database",
                str(final_backup),
                "--run-dir",
                str(final_inventory),
            ]
        )
        final_plan = read_json(final_inventory / "plan.json")
        if final_plan.get("sessions"):
            raise RuntimeError("final database still contains pure V1 sessions")
        final_classification = local_classification(final_backup)
        final_controller_status = controller_status(
            args.controller_base,
            app_code,
            user_id,
        )
        if final_controller_status["exists"]:
            controller_final_classification = optional_controller_classification(
                args.controller_base,
                app_code,
                user_id,
            )
            if controller_final_classification is not None:
                assert_same_classification(
                    final_classification,
                    controller_final_classification,
                    "final controller/backup",
                )
        if (
            final_classification["legacy_only"] != 0
            or final_classification["legacy_and_v2"]
            != initial_classification["legacy_and_v2"]
            or final_classification["pending_inputs"] != 0
            or final_classification["owned_aggregates"] != 0
        ):
            raise RuntimeError("final controller classification failed")
        write_json(final_dir / "classification.json", final_classification)
        accepted = True
        published_phase = "accepted"

        cleanup_report = cleanup_remote_temporaries(
            args.host,
            [
                (original_remote_path, original_hash),
                (clean_remote_path, migrated_hash),
            ],
        )
        write_json(final_dir / "remote-temp-cleanup.json", cleanup_report)

        if was_running:
            restored_status = ensure_sandbox_running(
                args.controller_base,
                app_code,
                user_id,
            )
        else:
            restored_status = controller_status(
                args.controller_base,
                app_code,
                user_id,
            )

        lock_release = migration_lock(
            args.host,
            "release",
            live_path,
            lock_token,
        )
        lock_acquired = False
        write_json(scope_dir / "migration-lock-release.json", lock_release)

        complete = {
            "schemaVersion": 1,
            "scope": scope,
            "status": "complete",
            "targetSessions": len(session_ids),
            "originalSha256": original_hash,
            "migratedSha256": migrated_hash,
            "finalSha256": clean_hash,
            "acceptanceMode": (
                "structural-messages"
                if args.structural_acceptance
                else "digest-and-continuation"
            ),
            "officialReplaySkipped": args.structural_acceptance,
            "sameSessionContinuationVerified": (
                None if args.structural_acceptance else True
            ),
            "messagesPrecleanVerified": True,
            "messagesPostcleanVerified": True,
            "registeredForAcceptance": registered_for_acceptance,
            "startedForAcceptance": started_for_acceptance,
            "finalControllerStatus": final_controller_status,
            "finalClassification": final_classification,
            "restoredSandboxStatus": restored_status,
            "exclusiveMigrationLockVerified": True,
            "completedAt": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ",
                time.gmtime(),
            ),
        }
        write_json(complete_path, complete)
        state.update({"phase": "complete"})
        write_json(scope_dir / "state.json", state)
        log(f"{scope}: complete; migrated {len(session_ids)} session(s)")
        return complete
    except Exception as error:
        failure = {
            "schemaVersion": 1,
            "scope": scope,
            "phase": published_phase,
            "errorType": type(error).__name__,
            "error": str(error),
            "acceptedBeforeFailure": accepted,
            "rollbackAttempted": False,
            "rollbackSucceeded": False,
            "failedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if published_phase in {"migrated", "clean"} and original_remote_path:
            failure["rollbackAttempted"] = True
            try:
                rollback = rollback_original(
                    host=args.host,
                    controller_base=args.controller_base,
                    app_code=app_code,
                    user_id=user_id,
                    live_path=live_path,
                    original_remote_path=original_remote_path,
                    original_hash=original_hash,
                )
                failure["rollbackSucceeded"] = True
                write_json(scope_dir / "rollback.json", rollback)
            except Exception as rollback_error:
                failure["rollbackErrorType"] = type(rollback_error).__name__
                failure["rollbackError"] = str(rollback_error)
        try:
            if was_running:
                ensure_sandbox_running(args.controller_base, app_code, user_id)
        except Exception as restore_error:
            failure["restoreErrorType"] = type(restore_error).__name__
            failure["restoreError"] = str(restore_error)
        if lock_acquired:
            try:
                lock_release = migration_lock(
                    args.host,
                    "release",
                    live_path,
                    lock_token,
                )
                lock_acquired = False
                failure["lockReleaseSucceeded"] = True
                write_json(
                    scope_dir / "migration-lock-release.json",
                    lock_release,
                )
            except Exception as lock_error:
                failure["lockReleaseSucceeded"] = False
                failure["lockReleaseErrorType"] = type(lock_error).__name__
                failure["lockReleaseError"] = str(lock_error)
        write_json(scope_dir / "failure.json", failure)
        state.update({"phase": "failed"})
        write_json(scope_dir / "state.json", state)
        raise


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--controller-base", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--scope", action="append", default=[])
    parser.add_argument("--max-databases", type=int)
    parser.add_argument("--global-pause-file")
    parser.add_argument("--structural-acceptance", action="store_true")
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

    run_root = private_directory(Path(args.run_dir).resolve())
    if args.global_pause_file:
        pause_path = Path(args.global_pause_file).resolve()
        if pause_path.parent != run_root.parent:
            raise SystemExit(
                "--global-pause-file must be a sibling of the worker run directory"
            )
        args.global_pause_file = str(pause_path)
        if pause_path.exists():
            raise SystemExit("global migration pause is already active")
    scan = remote_python(args.host, REMOTE / "scan_storage.py")
    scan["capturedAt"] = time.strftime(
        "%Y-%m-%dT%H:%M:%SZ",
        time.gmtime(),
    )
    write_json(run_root / "initial-scan.json", scan)
    candidates = [
        database
        for database in scan.get("databases", [])
        if database.get("classification") == "ok"
        and not str(database.get("userDir", "")).endswith(".bak")
        and database.get("legacyOnly", 0) > 0
    ]
    if any(
        database.get("pendingInputs", 0) != 0
        or database.get("ownedAggregates", 0) != 0
        for database in candidates
    ):
        raise RuntimeError("manifest contains pending input or owned aggregate")
    requested = set(args.scope)
    if requested:
        known = {
            f"{database['appCode']}/{database['userDir']}"
            for database in candidates
        }
        missing = requested - known
        if missing:
            raise RuntimeError(
                f"requested scope is not a current pure-V1 candidate: {sorted(missing)}"
            )
        candidates = [
            database
            for database in candidates
            if f"{database['appCode']}/{database['userDir']}" in requested
        ]
    candidates.sort(
        key=lambda database: (
            database.get("legacyOnly", 0),
            database.get("size", 0) + database.get("walSize", 0),
            database["appCode"],
            database["userDir"],
        )
    )
    if args.max_databases is not None:
        candidates = candidates[: args.max_databases]
    write_json(
        run_root / "selected-scopes.json",
        {
            "schemaVersion": 1,
            "databaseCount": len(candidates),
            "pureV1Sessions": sum(
                database.get("legacyOnly", 0) for database in candidates
            ),
            "scopes": [
                {
                    "appCode": database["appCode"],
                    "userId": database["userDir"],
                    "path": database["path"],
                    "sessions": database["sessions"],
                    "pureV1": database["legacyOnly"],
                    "legacyMessages": database["legacyMessages"],
                    "legacyParts": database["legacyParts"],
                }
                for database in candidates
            ],
        },
    )
    log(
        f"selected {len(candidates)} database(s), "
        f"{sum(database['legacyOnly'] for database in candidates)} pure V1 session(s)"
    )

    completed = []
    for database in candidates:
        scope = f"{database['appCode']}/{database['userDir']}"
        assert_global_not_paused(args, scope)
        try:
            completed.append(process_database(args, run_root, database))
        except Exception as error:
            signal_global_pause(args, scope, error)
            raise
    write_json(
        run_root / "batch-complete.json",
        {
            "schemaVersion": 1,
            "status": "complete",
            "databaseCount": len(completed),
            "migratedSessions": sum(item["targetSessions"] for item in completed),
            "scopes": [item["scope"] for item in completed],
            "completedAt": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ",
                time.gmtime(),
            ),
        },
    )
    log("batch complete")


if __name__ == "__main__":
    main()
