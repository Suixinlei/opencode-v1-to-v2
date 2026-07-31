#!/usr/bin/env python3
"""Delete one hash-verified temporary snapshot created by snapshot_copy.py."""

import hashlib
import json
import os
import re
import shutil
import sys


SNAPSHOT = re.compile(
    r"^/tmp/opencode-migration-snapshot-[^/]+/opencode\.db$"
)


def fail(message):
    print(json.dumps({"ok": False, "error": message}, separators=(",", ":")))
    raise SystemExit(1)


if len(sys.argv) != 3:
    fail("expected snapshot path and sha256")

path = os.path.realpath(sys.argv[1])
expected = sys.argv[2]
if not SNAPSHOT.fullmatch(path) or len(expected) != 64:
    fail("refusing unexpected snapshot path or digest")
if not os.path.isfile(path):
    fail("snapshot is missing")
with open(path, "rb") as handle:
    actual = hashlib.file_digest(handle, "sha256").hexdigest()
if actual != expected:
    fail("snapshot sha256 mismatch")
directory = os.path.dirname(path)
shutil.rmtree(directory)
if os.path.exists(directory):
    fail("snapshot cleanup was not durable")
print(
    json.dumps(
        {"ok": True, "path": path, "sha256": actual, "state": "deleted"},
        separators=(",", ":"),
        sort_keys=True,
    )
)
