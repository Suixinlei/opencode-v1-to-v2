#!/usr/bin/env python3
"""Acquire or release a fail-closed per-database migration lease marker."""

import hashlib
import json
import os
import re
import sys
import time


CANONICAL = re.compile(
    r"^/data/sandbox-storage/([^/]+)/([^/]+)/opencode/opencode\.db$"
)
TOKEN = re.compile(r"^[0-9a-f]{64}$")


def fail(message):
    print(json.dumps({"ok": False, "error": message}, separators=(",", ":")))
    raise SystemExit(1)


def fsync_directory(path):
    descriptor = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


if len(sys.argv) not in {3, 4}:
    fail("expected acquire|release|inspect, database path, and optional token")

operation = sys.argv[1]
database = os.path.realpath(sys.argv[2])
token = sys.argv[3] if len(sys.argv) == 4 else None
match = CANONICAL.fullmatch(database)
if (
    operation not in {"acquire", "release", "inspect"}
    or not match
    or match.group(2).endswith(".bak")
):
    fail("refusing unexpected operation or database path")
if operation in {"acquire", "release"} and (
    token is None or not TOKEN.fullmatch(token)
):
    fail("acquire and release require a 64-character lowercase hex token")
if operation == "inspect" and token is not None:
    fail("inspect does not accept a token")

database_directory = os.path.dirname(database)
lock_path = os.path.join(database_directory, ".opencode.db.migration-lock")
owner_path = os.path.join(lock_path, "owner.json")

if operation == "inspect":
    if not os.path.isdir(lock_path):
        result = {"ok": True, "operation": operation, "state": "absent"}
    else:
        if not os.path.isfile(owner_path):
            fail("migration lock exists without a regular owner file")
        with open(owner_path, encoding="utf-8") as handle:
            owner = json.load(handle)
        owner_token = owner.get("token")
        if not isinstance(owner_token, str) or not TOKEN.fullmatch(owner_token):
            fail("migration lock owner token is invalid")
        result = {
            "ok": True,
            "operation": operation,
            "state": "held",
            "tokenDigest": hashlib.sha256(owner_token.encode()).hexdigest(),
            "createdAtNs": owner.get("createdAtNs"),
        }
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    raise SystemExit(0)

if operation == "acquire":
    try:
        os.mkdir(lock_path, 0o700)
    except FileExistsError:
        fail("migration lock is already held")
    try:
        descriptor = os.open(
            owner_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        try:
            payload = json.dumps(
                {"token": token, "createdAtNs": time.time_ns()},
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
            written = os.write(descriptor, payload)
            if written != len(payload):
                fail("short write for migration lock owner")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        fsync_directory(lock_path)
        fsync_directory(database_directory)
    except Exception:
        try:
            if os.path.exists(owner_path):
                os.unlink(owner_path)
            os.rmdir(lock_path)
            fsync_directory(database_directory)
        finally:
            raise
    result = {
        "ok": True,
        "operation": operation,
        "state": "held",
        "tokenDigest": hashlib.sha256(token.encode()).hexdigest(),
    }
else:
    if not os.path.isdir(lock_path) or not os.path.isfile(owner_path):
        fail("migration lock is not held")
    with open(owner_path, encoding="utf-8") as handle:
        owner = json.load(handle)
    if owner.get("token") != token:
        fail("migration lock token mismatch")
    entries = sorted(os.listdir(lock_path))
    if entries != ["owner.json"]:
        fail("migration lock directory contains unexpected entries")
    os.unlink(owner_path)
    os.rmdir(lock_path)
    fsync_directory(database_directory)
    if os.path.exists(lock_path):
        fail("migration lock release was not durable")
    result = {
        "ok": True,
        "operation": operation,
        "state": "released",
        "tokenDigest": hashlib.sha256(token.encode()).hexdigest(),
    }

print(json.dumps(result, separators=(",", ":"), sort_keys=True))
