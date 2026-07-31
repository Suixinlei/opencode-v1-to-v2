#!/usr/bin/env python3
"""Read-only full inventory using checkpointed copies of canonical databases."""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

from production_storage_migrate import (
    REMOTE,
    REPO,
    controller_status,
    private_directory,
    read_json,
    remote_python,
    run_migration_cli,
    scp_from,
    sha256,
    write_json,
)


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--controller-base", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--scope", action="append", default=[])
    return parser.parse_args()


def main():
    args = parse_arguments()
    run_root = private_directory(Path(args.run_dir).resolve())
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
    requested = set(args.scope)
    if requested:
        candidates = [
            database
            for database in candidates
            if f"{database['appCode']}/{database['userDir']}" in requested
        ]
    candidates.sort(key=lambda value: (value["appCode"], value["userDir"]))

    results = []
    for index, database in enumerate(candidates, start=1):
        app_code = database["appCode"]
        user_id = database["userDir"]
        scope = f"{app_code}/{user_id}"
        print(
            f"[storage-inventory] {index}/{len(candidates)} {scope}",
            flush=True,
        )
        status = controller_status(args.controller_base, app_code, user_id)
        if status["state"].lower() == "running":
            raise RuntimeError(f"{scope}: source is running; read-only copy refused")

        scope_dir = private_directory(run_root / "databases" / app_code / user_id)
        snapshot = remote_python(
            args.host,
            REMOTE / "snapshot_copy.py",
            database["path"],
        )
        write_json(scope_dir / "snapshot.json", snapshot)
        local_database = private_directory(scope_dir / "snapshot") / "opencode.db"
        try:
            scp_from(args.host, snapshot["snapshotPath"], local_database)
            if sha256(local_database) != snapshot["sha256"]:
                raise RuntimeError(f"{scope}: downloaded snapshot hash mismatch")
        finally:
            cleanup = remote_python(
                args.host,
                REMOTE / "snapshot_cleanup.py",
                snapshot["snapshotPath"],
                snapshot["sha256"],
            )
            write_json(scope_dir / "snapshot-cleanup.json", cleanup)

        inventory_dir = private_directory(scope_dir / "inventory")
        run_migration_cli(
            [
                "inventory",
                "--database",
                str(local_database),
                "--run-dir",
                str(inventory_dir),
            ]
        )
        plan = read_json(inventory_dir / "plan.json")
        sessions = plan.get("sessions", [])
        blocked = [
            {
                "sessionId": session["sessionId"],
                "diagnosticCodes": sorted(
                    {
                        diagnostic["code"]
                        for diagnostic in session.get("diagnostics", [])
                        if diagnostic.get("severity") == "blocking"
                    }
                ),
            }
            for session in sessions
            if session.get("state") == "blocked"
        ]
        result = {
            "scope": scope,
            "manifestPureV1": database["legacyOnly"],
            "planSessions": len(sessions),
            "eligible": sum(
                session.get("state") in {"eligible", "resumable"}
                for session in sessions
            ),
            "blocked": len(blocked),
            "blockedSessions": blocked,
            "protectedSessions": len(plan.get("protectedSessions", [])),
            "snapshotSha256": snapshot["sha256"],
        }
        write_json(scope_dir / "result.json", result)
        results.append(result)

    summary = {
        "schemaVersion": 1,
        "sourceMutation": False,
        "databaseCount": len(results),
        "pureV1Sessions": sum(item["manifestPureV1"] for item in results),
        "eligibleSessions": sum(item["eligible"] for item in results),
        "blockedSessions": sum(item["blocked"] for item in results),
        "blockedScopes": [
            item["scope"] for item in results if item["blocked"] > 0
        ],
        "results": results,
        "completedAt": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ",
            time.gmtime(),
        ),
    }
    write_json(run_root / "summary.json", summary)
    print(
        json.dumps(
            {
                "databaseCount": summary["databaseCount"],
                "pureV1Sessions": summary["pureV1Sessions"],
                "eligibleSessions": summary["eligibleSessions"],
                "blockedSessions": summary["blockedSessions"],
                "blockedScopes": summary["blockedScopes"],
            },
            separators=(",", ":"),
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
