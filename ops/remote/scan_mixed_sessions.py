#!/usr/bin/env python3
"""WAL-aware, source-read-only structural inventory of mixed sessions."""

import glob
import json
import shutil
import sqlite3
import sys
import tempfile
from collections import Counter
from pathlib import Path


ROOT = Path("/data/sandbox-storage")
CANONICAL_GLOB = str(ROOT / "*" / "*" / "opencode" / "opencode.db")


def scalar(connection, sql, session_id):
    row = connection.execute(sql, (session_id,)).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def optional_scalar(connection, sql, session_id):
    row = connection.execute(sql, (session_id,)).fetchone()
    return row[0] if row else None


def range_values(connection, predicate, session_id):
    row = connection.execute(
        f"""SELECT MIN(seq), MAX(seq), COUNT(*)
            FROM event
            WHERE aggregate_id = ? AND {predicate}""",
        (session_id,),
    ).fetchone()
    return {
        "minimum": row[0],
        "maximum": row[1],
        "count": int(row[2]),
    }


def time_range(connection, table, session_id):
    row = connection.execute(
        f"""SELECT MIN(time_created), MAX(time_created)
            FROM "{table}" WHERE session_id = ?""",
        (session_id,),
    ).fetchone()
    return {"minimum": row[0], "maximum": row[1]}


def event_order(connection, session_id):
    labels = [
        "v2" if str(row[1]).startswith("session.next.") else "legacy"
        for row in connection.execute(
            """SELECT seq, type
               FROM event
               WHERE aggregate_id = ?
               ORDER BY seq""",
            (session_id,),
        )
    ]
    compressed = []
    for label in labels:
        if not compressed or compressed[-1] != label:
            compressed.append(label)
    return compressed


def frequencies(connection, sql, session_id):
    return dict(
        sorted(
            Counter(
                str(row[0])
                for row in connection.execute(sql, (session_id,))
            ).items()
        )
    )


def inspect_session(connection, session_id):
    sequence = connection.execute(
        """SELECT seq, owner_id
           FROM event_sequence
           WHERE aggregate_id = ?""",
        (session_id,),
    ).fetchone()
    return {
        "sessionId": session_id,
        "legacyMessages": scalar(
            connection,
            "SELECT COUNT(*) FROM message WHERE session_id = ?",
            session_id,
        ),
        "legacyParts": scalar(
            connection,
            "SELECT COUNT(*) FROM part WHERE session_id = ?",
            session_id,
        ),
        "legacyEventRange": range_values(
            connection,
            "type NOT LIKE 'session.next.%'",
            session_id,
        ),
        "v2EventRange": range_values(
            connection,
            "type LIKE 'session.next.%'",
            session_id,
        ),
        "eventOrder": event_order(connection, session_id),
        "eventSequence": sequence[0] if sequence else None,
        "eventOwned": bool(sequence and sequence[1] is not None),
        "v2Messages": scalar(
            connection,
            "SELECT COUNT(*) FROM session_message WHERE session_id = ?",
            session_id,
        ),
        "v2Inputs": scalar(
            connection,
            "SELECT COUNT(*) FROM session_input WHERE session_id = ?",
            session_id,
        ),
        "pendingInputs": scalar(
            connection,
            """SELECT COUNT(*) FROM session_input
               WHERE session_id = ? AND promoted_seq IS NULL""",
            session_id,
        ),
        "contextEpochs": scalar(
            connection,
            "SELECT COUNT(*) FROM session_context_epoch WHERE session_id = ?",
            session_id,
        ),
        "sameMessageIds": scalar(
            connection,
            """SELECT COUNT(*)
               FROM message m
               JOIN session_message sm
                 ON sm.session_id=m.session_id AND sm.id=m.id
               WHERE m.session_id = ?""",
            session_id,
        ),
        "legacyMessageTime": time_range(
            connection,
            "message",
            session_id,
        ),
        "v2MessageTime": time_range(
            connection,
            "session_message",
            session_id,
        ),
        "v2EventTypes": frequencies(
            connection,
            """SELECT type FROM event
               WHERE aggregate_id = ? AND type LIKE 'session.next.%'""",
            session_id,
        ),
        "v2MessageTypes": frequencies(
            connection,
            "SELECT type FROM session_message WHERE session_id = ?",
            session_id,
        ),
        "sessionVersion": optional_scalar(
            connection,
            "SELECT version FROM session WHERE id = ?",
            session_id,
        ),
    }


def inspect_database(path):
    relative = path.relative_to(ROOT)
    result = {
        "appCode": relative.parts[0],
        "userDir": relative.parts[1],
        "path": str(path),
        "walSize": (
            Path(f"{path}-wal").stat().st_size
            if Path(f"{path}-wal").exists()
            else 0
        ),
    }
    temporary = None
    connection = None
    try:
        if result["walSize"] > 0:
            temporary = tempfile.TemporaryDirectory(prefix="mixed-audit-")
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
        connection.execute("PRAGMA query_only = ON")
        session_ids = [
            str(row[0])
            for row in connection.execute(
                """WITH legacy AS (
                     SELECT session_id FROM message
                     UNION
                     SELECT session_id FROM part
                   ),
                   v2 AS (
                     SELECT aggregate_id AS session_id
                     FROM event WHERE type LIKE 'session.next.%'
                     UNION
                     SELECT session_id FROM session_message
                     UNION
                     SELECT session_id FROM session_input
                     UNION
                     SELECT session_id FROM session_context_epoch
                   )
                   SELECT s.id
                   FROM session s
                   WHERE s.id IN (
                     SELECT session_id FROM legacy
                     INTERSECT
                     SELECT session_id FROM v2
                   )
                   ORDER BY s.id"""
            )
        ]
        result["sessions"] = [
            inspect_session(connection, session_id)
            for session_id in session_ids
        ]
        result["quickCheck"] = [
            str(row[0]) for row in connection.execute("PRAGMA quick_check")
        ]
        result["foreignKeyViolations"] = len(
            list(connection.execute("PRAGMA foreign_key_check"))
        )
        return result
    finally:
        if connection is not None:
            connection.close()
        if temporary is not None:
            temporary.cleanup()


databases = []
errors = []
for raw_path in sorted(glob.glob(CANONICAL_GLOB)):
    path = Path(raw_path)
    relative = path.relative_to(ROOT)
    if relative.parts[1].endswith(".bak"):
        continue
    try:
        result = inspect_database(path)
        if result["sessions"]:
            databases.append(result)
    except Exception as error:
        errors.append(
            {
                "appCode": relative.parts[0],
                "userDir": relative.parts[1],
                "errorType": type(error).__name__,
            }
        )

print(
    json.dumps(
        {
            "schemaVersion": 1,
            "scanMode": "source-read-only-wal-aware",
            "databaseCount": len(databases),
            "sessionCount": sum(
                len(database["sessions"]) for database in databases
            ),
            "errors": errors,
            "databases": databases,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
)
