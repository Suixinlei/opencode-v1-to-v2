#!/usr/bin/env python3
"""Freeze and structurally classify current canonical mixed sessions."""

import argparse
import time
from collections import Counter
from pathlib import Path

from production_storage_migrate import (
    REMOTE,
    private_directory,
    remote_python,
    write_json,
)


BOOTSTRAP_TYPES = {
    "session.next.agent.switched.1",
    "session.next.model.switched.1",
}


def shape(session):
    order = session.get("eventOrder")
    event_types = set(session.get("v2EventTypes", {}))
    bootstrap_only = (
        bool(event_types)
        and event_types <= BOOTSTRAP_TYPES
        and session.get("v2Inputs") == 0
        and session.get("contextEpochs") == 0
    )
    if order == ["legacy", "v2", "legacy"] and bootstrap_only:
        return "bootstrap-v2-then-legacy"
    if order == ["legacy", "v2"]:
        return "legacy-then-v2"
    if order == ["legacy", "v2", "legacy"]:
        return "v2-then-legacy-tail"
    return "complex"


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--run-dir", required=True)
    return parser.parse_args()


def main():
    args = parse_arguments()
    run_root = private_directory(Path(args.run_dir).resolve())
    scan = remote_python(
        args.host,
        REMOTE / "scan_mixed_sessions.py",
    )
    captured_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    scan["capturedAt"] = captured_at
    write_json(run_root / "mixed-structural-scan.json", scan)
    if scan.get("errors"):
        raise RuntimeError("mixed structural scan contains database errors")

    sessions = []
    shape_counts = Counter()
    for database in scan.get("databases", []):
        for source in database.get("sessions", []):
            classification = shape(source)
            shape_counts[classification] += 1
            sessions.append(
                {
                    "scope": (
                        f"{database['appCode']}/{database['userDir']}"
                    ),
                    "appCode": database["appCode"],
                    "userId": database["userDir"],
                    "path": database["path"],
                    "readMode": database["readMode"],
                    "walSize": database["walSize"],
                    "sessionId": source["sessionId"],
                    "shape": classification,
                    "legacyMessages": source["legacyMessages"],
                    "legacyParts": source["legacyParts"],
                    "legacyEventRange": source["legacyEventRange"],
                    "v2EventRange": source["v2EventRange"],
                    "eventOrder": source["eventOrder"],
                    "eventSequence": source["eventSequence"],
                    "eventOwned": source["eventOwned"],
                    "v2Messages": source["v2Messages"],
                    "v2Inputs": source["v2Inputs"],
                    "pendingInputs": source["pendingInputs"],
                    "contextEpochs": source["contextEpochs"],
                    "sameMessageIds": source["sameMessageIds"],
                    "v2EventTypes": source["v2EventTypes"],
                    "v2MessageTypes": source["v2MessageTypes"],
                }
            )
    manifest = {
        "schemaVersion": 1,
        "sourceMutation": False,
        "capturedAt": captured_at,
        "excluded": [".bak", "workspace/.opencode"],
        "databaseCount": len(
            {session["scope"] for session in sessions}
        ),
        "sessionCount": len(sessions),
        "shapeCounts": dict(sorted(shape_counts.items())),
        "sessions": sessions,
    }
    write_json(run_root / "mixed-manifest.json", manifest)
    print(
        {
            "databaseCount": manifest["databaseCount"],
            "sessionCount": manifest["sessionCount"],
            "shapeCounts": manifest["shapeCounts"],
        }
    )


if __name__ == "__main__":
    main()
