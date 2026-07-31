#!/usr/bin/env python3
"""Hash-locked atomic exchange for a canonical database and same-dir candidate."""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys


CANONICAL = re.compile(
    r"^/data/sandbox-storage/([^/]+)/([^/]+)/opencode/opencode\.db$"
)


def fail(message):
    print(json.dumps({"ok": False, "error": message}, separators=(",", ":")))
    raise SystemExit(1)


def digest(path):
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


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


if len(sys.argv) != 5:
    fail("expected live path, candidate path, live sha256, candidate sha256")

live = os.path.realpath(sys.argv[1])
candidate = os.path.realpath(sys.argv[2])
expected_live = sys.argv[3]
expected_candidate = sys.argv[4]
match = CANONICAL.fullmatch(live)

if (
    not match
    or match.group(2).endswith(".bak")
    or os.path.dirname(candidate) != os.path.dirname(live)
    or not os.path.basename(candidate).startswith(".opencode.db.full-")
):
    fail("refusing unexpected live or candidate path")
if not os.path.isfile(live) or not os.path.isfile(candidate):
    fail("live or candidate database is missing")

related = [
    live,
    f"{live}-wal",
    f"{live}-shm",
    candidate,
    f"{candidate}-wal",
    f"{candidate}-shm",
]
if any(os.path.exists(path) for path in related if path not in {live, candidate}):
    fail("live or candidate WAL sidecar exists")
open_holders = holders(related)
if open_holders:
    fail("live or candidate database still has open file descriptors")

before_live = digest(live)
before_candidate = digest(candidate)
if before_live != expected_live:
    fail("live database sha256 changed")
if before_candidate != expected_candidate:
    fail("candidate database sha256 mismatch")

live_stat = os.stat(live)
os.chown(candidate, live_stat.st_uid, live_stat.st_gid)
os.chmod(candidate, stat.S_IMODE(live_stat.st_mode))
candidate_fd = os.open(candidate, os.O_RDONLY)
try:
    os.fsync(candidate_fd)
finally:
    os.close(candidate_fd)

subprocess.run(
    ["mv", "--exchange", "--no-copy", live, candidate],
    check=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.PIPE,
    text=True,
)
directory_fd = os.open(os.path.dirname(live), os.O_DIRECTORY)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)

after_live = digest(live)
after_candidate = digest(candidate)
if after_live != expected_candidate or after_candidate != expected_live:
    subprocess.run(
        ["mv", "--exchange", "--no-copy", live, candidate],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    rollback_dir_fd = os.open(os.path.dirname(live), os.O_DIRECTORY)
    try:
        os.fsync(rollback_dir_fd)
    finally:
        os.close(rollback_dir_fd)
    fail("post-swap sha256 mismatch; exchange rolled back")

published_stat = os.stat(live)
print(
    json.dumps(
        {
            "ok": True,
            "live": live,
            "rollback": candidate,
            "liveSha256": after_live,
            "rollbackSha256": after_candidate,
            "uid": published_stat.st_uid,
            "gid": published_stat.st_gid,
            "mode": oct(stat.S_IMODE(published_stat.st_mode)),
            "size": published_stat.st_size,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
)
