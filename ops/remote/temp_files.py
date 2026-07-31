#!/usr/bin/env python3
"""Hash-locked inspection/deletion of same-directory migration temporaries."""

import hashlib
import json
import os
import re
import sys


TEMPORARY = re.compile(
    r"^/data/sandbox-storage/([^/]+)/([^/]+)/opencode/"
    r"\.opencode\.db\.full-[A-Za-z0-9_.-]+$"
)


def digest(path):
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


if len(sys.argv) < 3 or sys.argv[1] not in {"inspect", "delete"}:
    raise SystemExit("usage: temp_files.py inspect|delete path[=sha256] ...")

operation = sys.argv[1]
results = []
for raw in sys.argv[2:]:
    requested_path, separator, expected_hash = raw.partition("=")
    path = os.path.realpath(requested_path)
    match = TEMPORARY.fullmatch(path)
    if not match or match.group(2).endswith(".bak"):
        raise SystemExit("refusing unexpected temporary file path")
    if not os.path.isfile(path):
        results.append({"path": path, "state": "absent"})
        continue
    actual_hash = digest(path)
    if operation == "delete":
        if not separator or len(expected_hash) != 64:
            raise SystemExit("delete requires an expected sha256")
        if actual_hash != expected_hash:
            raise SystemExit("temporary file sha256 mismatch")
        os.unlink(path)
        directory_fd = os.open(os.path.dirname(path), os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        if os.path.exists(path):
            raise SystemExit("temporary file deletion was not durable")
        results.append({"path": path, "state": "deleted", "sha256": actual_hash})
    else:
        metadata = os.stat(path)
        results.append(
            {
                "path": path,
                "state": "present",
                "sha256": actual_hash,
                "size": metadata.st_size,
                "uid": metadata.st_uid,
                "gid": metadata.st_gid,
                "mode": oct(metadata.st_mode & 0o777),
            }
        )

print(
    json.dumps(
        {"ok": True, "operation": operation, "files": results},
        separators=(",", ":"),
        sort_keys=True,
    )
)
