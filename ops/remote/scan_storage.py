#!/usr/bin/env python3
"""Read-only inventory for canonical sandbox OpenCode databases.

Non-empty WAL files are copied together with the main database into a temporary
directory. SQLite is opened only on that copy, so the source database and its
shared-memory sidecar are never touched by the inventory.
"""

import glob
import json
import shutil
import sqlite3
import sys
import tempfile
from collections import defaultdict
from pathlib import Path


ROOT = Path("/data/sandbox-storage")
CANONICAL_GLOB = str(ROOT / "*" / "*" / "opencode" / "opencode.db")


def table_names(connection):
    return {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }


def column_names(connection, table):
    return {
        row[1]
        for row in connection.execute(f'PRAGMA table_info("{table}")')
    }


def scalar(connection, sql):
    row = connection.execute(sql).fetchone()
    return int(row[0]) if row else 0


def id_set(connection, sql):
    return {str(row[0]) for row in connection.execute(sql) if row[0] is not None}


def classify(connection, result):
    connection.execute("PRAGMA query_only = ON")
    tables = table_names(connection)
    result["tables"] = sorted(
        tables
        & {
            "session",
            "message",
            "part",
            "event",
            "event_sequence",
            "session_message",
            "session_input",
            "session_context_epoch",
        }
    )
    if "session" not in tables:
        result["classification"] = "no-session-table"
        return result

    sessions = id_set(connection, "SELECT id FROM session")
    legacy = set()
    if "message" in tables:
        legacy |= id_set(connection, "SELECT DISTINCT session_id FROM message")
    if "part" in tables:
        legacy |= id_set(connection, "SELECT DISTINCT session_id FROM part")

    v2 = set()
    if "event" in tables:
        v2 |= id_set(
            connection,
            "SELECT DISTINCT aggregate_id FROM event "
            "WHERE type LIKE 'session.next.%'",
        )
    for table in ("session_message", "session_input", "session_context_epoch"):
        if table in tables:
            v2 |= id_set(connection, f'SELECT DISTINCT session_id FROM "{table}"')

    result.update(
        {
            "classification": "ok",
            "sessions": len(sessions),
            "legacyOnly": len((legacy - v2) & sessions),
            "legacyAndV2": len((legacy & v2) & sessions),
            "v2Only": len((v2 - legacy) & sessions),
            "neither": len(sessions - legacy - v2),
            "legacyMessages": (
                scalar(connection, "SELECT COUNT(*) FROM message")
                if "message" in tables
                else 0
            ),
            "legacyParts": (
                scalar(connection, "SELECT COUNT(*) FROM part")
                if "part" in tables
                else 0
            ),
            "pendingInputs": (
                scalar(
                    connection,
                    "SELECT COUNT(*) FROM session_input "
                    "WHERE promoted_seq IS NULL",
                )
                if "session_input" in tables
                else 0
            ),
            "ownedAggregates": (
                scalar(
                    connection,
                    "SELECT COUNT(*) FROM event_sequence "
                    "WHERE owner_id IS NOT NULL",
                )
                if "event_sequence" in tables
                and "owner_id" in column_names(connection, "event_sequence")
                else 0
            ),
            "legacyOnlySessionIds": sorted((legacy - v2) & sessions),
        }
    )
    return result


def inspect(path):
    relative = path.relative_to(ROOT)
    result = {
        "appCode": relative.parts[0],
        "userDir": relative.parts[1],
        "path": str(path),
        "size": path.stat().st_size,
        "mtimeNs": path.stat().st_mtime_ns,
        "walSize": (
            Path(f"{path}-wal").stat().st_size
            if Path(f"{path}-wal").exists()
            else 0
        ),
        "shmSize": (
            Path(f"{path}-shm").stat().st_size
            if Path(f"{path}-shm").exists()
            else 0
        ),
    }
    temporary = None
    connection = None
    try:
        if result["walSize"] > 0:
            temporary = tempfile.TemporaryDirectory(prefix="opencode-audit-")
            copy_path = Path(temporary.name) / "opencode.db"
            shutil.copyfile(path, copy_path)
            shutil.copyfile(Path(f"{path}-wal"), Path(f"{copy_path}-wal"))
            connection = sqlite3.connect(str(copy_path))
            result["readMode"] = "source-read-only-wal-copy"
        else:
            connection = sqlite3.connect(
                f"{path.as_uri()}?mode=ro&immutable=1",
                uri=True,
            )
            result["readMode"] = "immutable"
        return classify(connection, result)
    finally:
        if connection is not None:
            connection.close()
        if temporary is not None:
            temporary.cleanup()


def main():
    databases = []
    for path in sorted(Path(value) for value in glob.glob(CANONICAL_GLOB)):
        try:
            databases.append(inspect(path))
        except Exception as error:
            relative = path.relative_to(ROOT)
            databases.append(
                {
                    "appCode": relative.parts[0],
                    "userDir": relative.parts[1],
                    "path": str(path),
                    "classification": "error",
                    "errorType": type(error).__name__,
                }
            )

    totals = defaultdict(int)
    by_app = defaultdict(lambda: defaultdict(int))
    for database in databases:
        totals["databases"] += 1
        app = by_app[database["appCode"]]
        app["databases"] += 1
        for key in (
            "sessions",
            "legacyOnly",
            "legacyAndV2",
            "v2Only",
            "neither",
            "legacyMessages",
            "legacyParts",
            "pendingInputs",
            "ownedAggregates",
        ):
            value = int(database.get(key, 0))
            totals[key] += value
            app[key] += value
        if database.get("walSize", 0) > 0:
            totals["nonemptyWal"] += 1
            app["nonemptyWal"] += 1
        if database.get("classification") == "error":
            totals["errors"] += 1
            app["errors"] += 1
        if database["userDir"].endswith(".bak"):
            totals["backupDirectories"] += 1
            app["backupDirectories"] += 1

    json.dump(
        {
            "schemaVersion": 1,
            "scanMode": "source-read-only",
            "root": str(ROOT),
            "totals": dict(totals),
            "byApp": [
                {"appCode": app_code, **dict(values)}
                for app_code, values in sorted(by_app.items())
            ],
            "databases": databases,
        },
        sys.stdout,
        separators=(",", ":"),
        sort_keys=True,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
