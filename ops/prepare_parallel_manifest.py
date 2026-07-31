#!/usr/bin/env python3
"""Freeze and balance the current canonical pure-V1 production scope."""

import argparse
import time
from pathlib import Path

from production_storage_migrate import (
    REMOTE,
    private_directory,
    remote_python,
    write_json,
)


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--workers", type=int, default=2)
    return parser.parse_args()


def work_units(database):
    return (
        1000
        + int(database.get("legacyMessages", 0))
        + int(database.get("legacyParts", 0))
        + int(database.get("legacyOnly", 0)) * 20
        + (int(database.get("size", 0)) + int(database.get("walSize", 0)))
        // 4096
    )


def main():
    args = parse_arguments()
    if args.workers < 1:
        raise SystemExit("--workers must be positive")
    run_root = private_directory(Path(args.run_dir).resolve())
    scan = remote_python(args.host, REMOTE / "scan_storage.py")
    scan["capturedAt"] = time.strftime(
        "%Y-%m-%dT%H:%M:%SZ",
        time.gmtime(),
    )
    write_json(run_root / "frozen-scan.json", scan)

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
    paths = [database["path"] for database in candidates]
    if len(paths) != len(set(paths)):
        raise RuntimeError("manifest contains duplicate canonical paths")

    groups = [
        {"worker": index + 1, "workUnits": 0, "scopes": []}
        for index in range(args.workers)
    ]
    for database in sorted(
        candidates,
        key=lambda item: (
            -work_units(item),
            item["appCode"],
            item["userDir"],
        ),
    ):
        group = min(
            groups,
            key=lambda item: (item["workUnits"], item["worker"]),
        )
        units = work_units(database)
        group["workUnits"] += units
        group["scopes"].append(
            {
                "scope": f"{database['appCode']}/{database['userDir']}",
                "path": database["path"],
                "sessions": database["sessions"],
                "pureV1": database["legacyOnly"],
                "legacyMessages": database["legacyMessages"],
                "legacyParts": database["legacyParts"],
                "workUnits": units,
            }
        )

    for group in groups:
        group["scopes"].sort(key=lambda item: item["scope"])
        group["databaseCount"] = len(group["scopes"])
        group["pureV1Sessions"] = sum(
            item["pureV1"] for item in group["scopes"]
        )

    manifest = {
        "schemaVersion": 1,
        "sourceMutation": False,
        "databaseCount": len(candidates),
        "pureV1Sessions": sum(
            database["legacyOnly"] for database in candidates
        ),
        "excluded": [".bak", "workspace/.opencode"],
        "groups": groups,
        "createdAt": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ",
            time.gmtime(),
        ),
    }
    write_json(run_root / "parallel-manifest.json", manifest)
    print(
        {
            "databaseCount": manifest["databaseCount"],
            "pureV1Sessions": manifest["pureV1Sessions"],
            "groups": [
                {
                    "worker": group["worker"],
                    "databaseCount": group["databaseCount"],
                    "pureV1Sessions": group["pureV1Sessions"],
                    "workUnits": group["workUnits"],
                }
                for group in groups
            ],
        }
    )


if __name__ == "__main__":
    main()
