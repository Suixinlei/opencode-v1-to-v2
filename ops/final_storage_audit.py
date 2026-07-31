#!/usr/bin/env python3
"""Read-only final audit for canonical production OpenCode databases."""

import argparse
import time
from collections import defaultdict
from pathlib import Path

from production_storage_migrate import (
    REMOTE,
    private_directory,
    remote_python,
    write_json,
)


COUNTERS = (
    "sessions",
    "legacyOnly",
    "legacyAndV2",
    "v2Only",
    "neither",
    "legacyMessages",
    "legacyParts",
    "pendingInputs",
    "ownedAggregates",
)


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--run-dir", required=True)
    return parser.parse_args()


def main():
    args = parse_arguments()
    run_root = private_directory(Path(args.run_dir).resolve())
    scan = remote_python(args.host, REMOTE / "scan_storage.py")
    residue = remote_python(
        args.host,
        REMOTE / "scan_migration_residue.py",
    )
    captured_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    scan["capturedAt"] = captured_at
    residue["capturedAt"] = captured_at
    write_json(run_root / "wal-aware-scan.json", scan)
    write_json(run_root / "migration-residue-scan.json", residue)

    canonical = [
        database
        for database in scan.get("databases", [])
        if not str(database.get("userDir", "")).endswith(".bak")
    ]
    totals = defaultdict(int)
    errors = []
    for database in canonical:
        if database.get("classification") != "ok":
            errors.append(
                {
                    "appCode": database.get("appCode"),
                    "userId": database.get("userDir"),
                    "classification": database.get("classification"),
                }
            )
        for counter in COUNTERS:
            totals[counter] += int(database.get(counter, 0))
        totals["databases"] += 1
        if int(database.get("walSize", 0)) > 0:
            totals["nonemptyWal"] += 1

    checks = {
        "classificationErrorsZero": len(errors) == 0,
        "pureV1Zero": totals["legacyOnly"] == 0,
        "pendingInputsZero": totals["pendingInputs"] == 0,
        "ownedAggregatesZero": totals["ownedAggregates"] == 0,
        "migrationLocksZero": int(residue.get("lockCount", -1)) == 0,
        "migrationTemporariesZero": (
            int(residue.get("temporaryCount", -1)) == 0
        ),
    }
    report = {
        "schemaVersion": 1,
        "capturedAt": captured_at,
        "scope": (
            "/data/sandbox-storage/<app>/<user>/opencode/opencode.db "
            "excluding *.bak"
        ),
        "scanMode": "source-read-only-wal-aware",
        "totals": dict(totals),
        "classificationErrors": errors,
        "protectedMixedLegacyV2Sessions": totals["legacyAndV2"],
        "residue": {
            "lockCount": residue.get("lockCount"),
            "temporaryCount": residue.get("temporaryCount"),
        },
        "checks": checks,
        "verified": all(checks.values()),
    }
    write_json(run_root / "final-audit.json", report)
    print(report)
    if not report["verified"]:
        raise RuntimeError("final production storage audit failed")


if __name__ == "__main__":
    main()
