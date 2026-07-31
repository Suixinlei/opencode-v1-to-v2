#!/usr/bin/env python3
"""Create a checkpointed temporary copy without opening the source in SQLite."""

import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import sys
import tempfile


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
    fail("expected exactly one canonical database path")

source = os.path.realpath(sys.argv[1])
match = CANONICAL.fullmatch(source)
if not match or match.group(2).endswith(".bak") or not os.path.isfile(source):
    fail("refusing non-canonical, backup, or missing source")

related = [source, f"{source}-wal", f"{source}-shm"]
before_holders = holders(related)
if before_holders:
    fail("source database or WAL sidecar has open file descriptors")

before = {
    path: (os.path.getsize(path), os.stat(path).st_mtime_ns)
    for path in related
    if os.path.exists(path)
}
temporary_dir = tempfile.mkdtemp(prefix="opencode-migration-snapshot-", dir="/tmp")
snapshot = os.path.join(temporary_dir, "opencode.db")
try:
    shutil.copyfile(source, snapshot)
    if os.path.exists(f"{source}-wal") and os.path.getsize(f"{source}-wal") > 0:
        shutil.copyfile(f"{source}-wal", f"{snapshot}-wal")

    after = {
        path: (os.path.getsize(path), os.stat(path).st_mtime_ns)
        for path in related
        if os.path.exists(path)
    }
    if before != after or holders(related):
        fail("source changed or acquired a holder while copying")

    database = sqlite3.connect(snapshot, timeout=5)
    try:
        database.execute("PRAGMA busy_timeout=5000")
        checkpoint = list(database.execute("PRAGMA wal_checkpoint(TRUNCATE)"))[0]
        quick_check = [row[0] for row in database.execute("PRAGMA quick_check")]
        foreign_keys = list(database.execute("PRAGMA foreign_key_check"))
    finally:
        database.close()
    if checkpoint[0] != 0:
        fail("temporary snapshot WAL checkpoint was busy")
    if quick_check != ["ok"] or foreign_keys:
        fail("temporary snapshot integrity check failed")
    if os.path.exists(f"{snapshot}-wal") and os.path.getsize(f"{snapshot}-wal") != 0:
        fail("temporary snapshot retained a nonempty WAL")

    os.chmod(snapshot, 0o600)
    with open(snapshot, "rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    metadata = os.stat(snapshot)
    print(
        json.dumps(
            {
                "ok": True,
                "source": source,
                "sourceMutation": False,
                "sourceHolders": before_holders,
                "snapshotPath": snapshot,
                "sha256": digest,
                "size": metadata.st_size,
                "mode": oct(stat.S_IMODE(metadata.st_mode)),
                "quickCheck": quick_check,
                "foreignKeyViolations": 0,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
except BaseException:
    shutil.rmtree(temporary_dir, ignore_errors=True)
    raise
