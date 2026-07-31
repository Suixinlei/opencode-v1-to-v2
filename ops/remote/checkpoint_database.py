#!/usr/bin/env python3
"""Fail-closed checkpoint and integrity gate for one canonical live database."""

import hashlib
import json
import os
import re
import sqlite3
import stat
import sys


CANONICAL = re.compile(
    r"^/data/sandbox-storage/([^/]+)/([^/]+)/opencode/opencode\.db$"
)


def fail(message):
    print(json.dumps({"ok": False, "error": message}, separators=(",", ":")))
    raise SystemExit(1)


def holders(paths):
    canonical = {os.path.realpath(path) for path in paths if os.path.exists(path)}
    result = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        fd_root = f"/proc/{pid}/fd"
        try:
            for fd in os.listdir(fd_root):
                try:
                    if os.path.realpath(os.path.join(fd_root, fd)) in canonical:
                        result.append(int(pid))
                        break
                except OSError:
                    continue
        except OSError:
            continue
    return sorted(set(result))


if len(sys.argv) != 2:
    fail("expected exactly one database path")

path = os.path.realpath(sys.argv[1])
match = CANONICAL.fullmatch(path)
if not match or match.group(2).endswith(".bak"):
    fail("refusing non-canonical or backup database path")
if not os.path.isfile(path):
    fail("database does not exist")

related = [path, f"{path}-wal", f"{path}-shm"]
open_holders = holders(related)
if open_holders:
    fail("database or WAL sidecar still has open file descriptors")

database = sqlite3.connect(path, timeout=5)
try:
    database.execute("PRAGMA busy_timeout=5000")
    checkpoint = list(database.execute("PRAGMA wal_checkpoint(TRUNCATE)"))[0]
    quick_check = [row[0] for row in database.execute("PRAGMA quick_check")]
    foreign_key_violations = list(database.execute("PRAGMA foreign_key_check"))
finally:
    database.close()

wal_size = os.path.getsize(f"{path}-wal") if os.path.exists(f"{path}-wal") else 0
if checkpoint[0] != 0 or wal_size != 0:
    fail("WAL checkpoint did not reach a quiescent zero-WAL state")
if quick_check != ["ok"]:
    fail("quick_check failed")
if foreign_key_violations:
    fail("foreign_key_check failed")
if holders(related):
    fail("database acquired a writer during checkpoint")

with open(path, "rb") as handle:
    digest = hashlib.file_digest(handle, "sha256").hexdigest()
metadata = os.stat(path)
sidecars = {}
for suffix in ("-wal", "-shm"):
    sidecar = path + suffix
    sidecars[suffix] = os.path.getsize(sidecar) if os.path.exists(sidecar) else None

print(
    json.dumps(
        {
            "ok": True,
            "path": path,
            "checkpoint": checkpoint,
            "quickCheck": quick_check,
            "foreignKeyViolations": 0,
            "sha256": digest,
            "size": metadata.st_size,
            "uid": metadata.st_uid,
            "gid": metadata.st_gid,
            "mode": oct(stat.S_IMODE(metadata.st_mode)),
            "sidecars": sidecars,
            "holdersBeforeCheckpoint": open_holders,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
)
