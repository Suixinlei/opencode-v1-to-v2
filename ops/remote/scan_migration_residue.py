#!/usr/bin/env python3
"""Read-only scan for canonical migration locks and temporary databases."""

import glob
import hashlib
import json
import os
from pathlib import Path


ROOT = Path("/data/sandbox-storage")
OPENCODE_GLOB = str(ROOT / "*" / "*" / "opencode")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


locks = []
temporaries = []
for raw_directory in sorted(glob.glob(OPENCODE_GLOB)):
    directory = Path(raw_directory)
    relative = directory.relative_to(ROOT)
    if len(relative.parts) != 3 or relative.parts[1].endswith(".bak"):
        continue

    lock = directory / ".opencode.db.migration-lock"
    if os.path.lexists(lock):
        locks.append(
            {
                "path": str(lock),
                "kind": (
                    "directory"
                    if lock.is_dir()
                    else "file"
                    if lock.is_file()
                    else "other"
                ),
            }
        )

    for temporary in sorted(directory.glob(".opencode.db.full-*")):
        entry = {
            "path": str(temporary),
            "kind": (
                "file"
                if temporary.is_file()
                else "directory"
                if temporary.is_dir()
                else "other"
            ),
        }
        if temporary.is_file():
            metadata = temporary.stat()
            entry.update(
                {
                    "size": metadata.st_size,
                    "sha256": sha256(temporary),
                }
            )
        temporaries.append(entry)

print(
    json.dumps(
        {
            "schemaVersion": 1,
            "scanMode": "source-read-only",
            "locks": locks,
            "temporaries": temporaries,
            "lockCount": len(locks),
            "temporaryCount": len(temporaries),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
)
