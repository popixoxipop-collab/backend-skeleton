#!/usr/bin/env python3
"""T24 M4 pre-execution MuJoCo runtime inventory collector.

This collector performs filesystem-only inventory. It does not import MuJoCo,
launch Python, compile MJCF, create MjData, or execute target code.

It verifies the installed MuJoCo wheel RECORD against actual installed bytes and
produces a canonical runtime-closure digest that can be reviewed before any M4
execution admission decision.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
from typing import Any

REQUEST_PROTOCOL = "sbf.sim-mujoco-runtime-inventory-request/draft-1"
OUTPUT_SCHEMA = "sbf.sim-mujoco-runtime-inventory/draft-1"
STATUS = "INVENTORY_OBSERVED_NOT_ADMITTED"
SUPPORTED_MUJOCO_VERSION = "3.12.0"
MAX_REQUEST_BYTES = 64 * 1024
MAX_RECORD_BYTES = 4 * 1024 * 1024
MAX_ENTRIES = 20_000
MAX_FILE_BYTES = 512 * 1024 * 1024
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
PYTHON_DIR_RE = re.compile(r"^python(\d+)\.(\d+)$")


class InventoryError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InventoryError("REQUEST_INVALID", f"{label} must be an object")
    actual = set(value)
    extra = sorted(actual - expected)
    missing = sorted(expected - actual)
    if extra:
        raise InventoryError("REQUEST_INVALID", f"{label} contains unsupported fields: {', '.join(extra)}")
    if missing:
        raise InventoryError("REQUEST_INVALID", f"{label} is missing required fields: {', '.join(missing)}")
    return value


def _absolute_path(value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise InventoryError("REQUEST_INVALID", f"{label} must be a non-empty absolute path")
    path = Path(value)
    if not path.is_absolute():
        raise InventoryError("REQUEST_INVALID", f"{label} must be absolute")
    return path


def _read_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise InventoryError("REQUEST_INVALID", "inventory request exceeds byte limit")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise InventoryError("REQUEST_INVALID", "inventory request must be valid UTF-8") from exc

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in items:
            if key in out:
                raise InventoryError("REQUEST_INVALID", f"duplicate JSON key: {key}")
            out[key] = value
        return out

    def constant(value: str) -> Any:
        raise InventoryError("REQUEST_INVALID", f"non-standard JSON number: {value}")

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    except json.JSONDecodeError as exc:
        raise InventoryError("REQUEST_INVALID", "inventory request must be valid JSON") from exc

    value = _exact_keys(
        value,
        {"protocol", "venv_root", "helper_path", "expected_mujoco_version"},
        "inventory request",
    )
    if value["protocol"] != REQUEST_PROTOCOL:
        raise InventoryError("REQUEST_INVALID", "inventory request protocol is invalid")
    if value["expected_mujoco_version"] != SUPPORTED_MUJOCO_VERSION:
        raise InventoryError(
            "REQUEST_INVALID",
            f"expected_mujoco_version must be {SUPPORTED_MUJOCO_VERSION}",
        )
    return {
        "protocol": REQUEST_PROTOCOL,
        "venv_root": _absolute_path(value["venv_root"], "venv_root"),
        "helper_path": _absolute_path(value["helper_path"], "helper_path"),
        "expected_mujoco_version": SUPPORTED_MUJOCO_VERSION,
    }


def _hash_regular(path: Path, label: str) -> dict[str, Any]:
    try:
        stat = path.lstat()
    except FileNotFoundError as exc:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", f"{label} is missing") from exc
    if path.is_symlink():
        raise InventoryError("RUNTIME_INVENTORY_INVALID", f"{label} must not be a symlink")
    if not path.is_file():
        raise InventoryError("RUNTIME_INVENTORY_INVALID", f"{label} must be a regular file")
    if stat.st_size > MAX_FILE_BYTES:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", f"{label} exceeds file byte budget")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "size_bytes": size}


def _hash_launcher(path: Path) -> dict[str, Any]:
    try:
        requested = path.absolute()
        resolved = path.resolve(strict=True)
    except FileNotFoundError as exc:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "Python launcher is missing") from exc
    if not resolved.is_file():
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "resolved Python launcher must be a regular file")
    data = _hash_regular(resolved, "resolved Python launcher")
    return {
        "requested_path": str(requested),
        "resolved_path": str(resolved),
        **data,
    }


def _site_packages(venv_root: Path) -> tuple[Path, str]:
    lib = venv_root / "lib"
    if not lib.is_dir():
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "venv lib directory is missing")
    matches: list[tuple[Path, str]] = []
    for child in lib.iterdir():
        match = PYTHON_DIR_RE.match(child.name)
        if not match:
            continue
        site = child / "site-packages"
        if site.is_dir():
            matches.append((site, f"{match.group(1)}.{match.group(2)}"))
    if len(matches) != 1:
        raise InventoryError(
            "RUNTIME_INVENTORY_INVALID",
            "venv must expose exactly one lib/pythonX.Y/site-packages directory",
        )
    return matches[0]


def _metadata_version(metadata: Path) -> str:
    raw = metadata.read_bytes()
    if len(raw) > MAX_RECORD_BYTES:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "METADATA exceeds byte budget")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "METADATA must be valid UTF-8") from exc
    versions = [line[9:].strip() for line in text.splitlines() if line.startswith("Version: ")]
    if versions != [SUPPORTED_MUJOCO_VERSION]:
        raise InventoryError(
            "RUNTIME_INVENTORY_INVALID",
            f"METADATA must identify exactly MuJoCo {SUPPORTED_MUJOCO_VERSION}",
        )
    return versions[0]


def _record_digest(encoded: str, label: str) -> str:
    if not encoded.startswith("sha256="):
        raise InventoryError("RUNTIME_INVENTORY_INVALID", f"{label} must use sha256 RECORD hashes")
    raw = encoded[len("sha256="):]
    padding = "=" * ((4 - len(raw) % 4) % 4)
    try:
        digest = base64.urlsafe_b64decode(raw + padding).hex()
    except Exception as exc:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", f"{label} contains invalid RECORD hash") from exc
    if not SHA256_RE.match(digest):
        raise InventoryError("RUNTIME_INVENTORY_INVALID", f"{label} decoded hash is invalid")
    return digest


def _inside(root: Path, candidate: Path) -> Path:
    try:
        return candidate.relative_to(root)
    except ValueError as exc:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "RECORD path escapes site-packages") from exc


def _verify_record(site_packages: Path, record_path: Path) -> list[dict[str, Any]]:
    raw = record_path.read_bytes()
    if len(raw) > MAX_RECORD_BYTES:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "RECORD exceeds byte budget")
    try:
        rows = list(csv.reader(io.StringIO(raw.decode("utf-8", errors="strict"))))
    except (UnicodeDecodeError, csv.Error) as exc:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "RECORD is invalid UTF-8/CSV") from exc
    if len(rows) > MAX_ENTRIES:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "RECORD exceeds entry limit")

    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, row in enumerate(rows):
        if len(row) != 3:
            raise InventoryError("RUNTIME_INVENTORY_INVALID", f"RECORD row {index} must have 3 columns")
        relative, encoded_hash, encoded_size = row
        if not relative or "\\" in relative or relative.startswith("/"):
            raise InventoryError("RUNTIME_INVENTORY_INVALID", f"RECORD row {index} path is invalid")
        parts = relative.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise InventoryError("RUNTIME_INVENTORY_INVALID", f"RECORD row {index} path contains unsafe segments")
        if relative in seen:
            raise InventoryError("RUNTIME_INVENTORY_INVALID", f"duplicate RECORD path: {relative}")
        seen.add(relative)

        # The RECORD file itself is the one standard unhashed row. Every other
        # installed MuJoCo/dist-info file must carry hash+size and match bytes.
        is_record = relative == f"mujoco-{SUPPORTED_MUJOCO_VERSION}.dist-info/RECORD"
        if is_record:
            if encoded_hash or encoded_size:
                raise InventoryError("RUNTIME_INVENTORY_INVALID", "RECORD self-row must be unhashed")
            continue
        if not encoded_hash or not encoded_size:
            raise InventoryError("RUNTIME_INVENTORY_INVALID", f"RECORD row {index} is missing hash or size")
        try:
            expected_size = int(encoded_size, 10)
        except ValueError as exc:
            raise InventoryError("RUNTIME_INVENTORY_INVALID", f"RECORD row {index} size is invalid") from exc
        if expected_size < 0:
            raise InventoryError("RUNTIME_INVENTORY_INVALID", f"RECORD row {index} size is negative")
        expected_sha = _record_digest(encoded_hash, f"RECORD row {index}")

        requested = site_packages / relative
        try:
            requested.lstat()
        except FileNotFoundError as exc:
            raise InventoryError(
                "RUNTIME_INVENTORY_INVALID",
                f"installed RECORD entry is missing: {relative}",
            ) from exc
        if requested.is_symlink():
            raise InventoryError(
                "RUNTIME_INVENTORY_INVALID",
                f"installed RECORD entry is a symlink: {relative}",
            )
        candidate = requested.resolve(strict=True)
        _inside(site_packages.resolve(strict=True), candidate)
        actual = _hash_regular(candidate, f"installed RECORD entry {relative}")
        if actual["size_bytes"] != expected_size or actual["sha256"] != expected_sha:
            raise InventoryError("RUNTIME_INVENTORY_INVALID", f"installed bytes do not match RECORD: {relative}")
        entries.append({
            "path": relative,
            "sha256": actual["sha256"],
            "size_bytes": actual["size_bytes"],
        })

    if not entries:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "RECORD verified zero installed files")
    entries.sort(key=lambda item: item["path"])
    return entries


def _closure_digest(entries: list[dict[str, Any]]) -> str:
    payload = json.dumps(entries, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(b"sbf.sim-mujoco-runtime-closure/draft-1\n" + payload + b"\n").hexdigest()


def collect(request: dict[str, Any]) -> dict[str, Any]:
    venv_root = request["venv_root"].resolve(strict=True)
    if not venv_root.is_dir():
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "venv_root must resolve to a directory")

    site_packages, python_abi = _site_packages(venv_root)
    dist_info = site_packages / f"mujoco-{SUPPORTED_MUJOCO_VERSION}.dist-info"
    record_path = dist_info / "RECORD"
    metadata_path = dist_info / "METADATA"
    package_root = site_packages / "mujoco"
    native_rel = f"mujoco/libmujoco.so.{SUPPORTED_MUJOCO_VERSION}"
    native_path = site_packages / native_rel

    if not package_root.is_dir() or not dist_info.is_dir():
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "MuJoCo package/dist-info directories are missing")

    version = _metadata_version(metadata_path)
    entries = _verify_record(site_packages, record_path)
    by_path = {entry["path"]: entry for entry in entries}
    if native_rel not in by_path:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "native MuJoCo library is absent from verified RECORD closure")

    bindings = [
        entry for entry in entries
        if entry["path"].startswith("mujoco/")
        and entry["path"].endswith(".so")
        and entry["path"] != native_rel
    ]
    if not bindings:
        raise InventoryError("RUNTIME_INVENTORY_INVALID", "verified MuJoCo closure contains no Python extension bindings")

    record_hash = _hash_regular(record_path, "MuJoCo RECORD")
    metadata_hash = _hash_regular(metadata_path, "MuJoCo METADATA")
    helper_path = request["helper_path"]
    helper_hash = _hash_regular(helper_path, "M3 helper")
    launcher = _hash_launcher(venv_root / "bin" / "python")

    return {
        "schema": OUTPUT_SCHEMA,
        "status": STATUS,
        "mujoco_version": version,
        "python_abi": python_abi,
        "venv_root": str(venv_root),
        "site_packages": str(site_packages.resolve(strict=True)),
        "launcher": launcher,
        "helper": {
            "path": str(helper_path.absolute()),
            **helper_hash,
        },
        "record": {
            "path": str(record_path.resolve(strict=True)),
            **record_hash,
            "verified_entry_count": len(entries),
        },
        "metadata": {
            "path": str(metadata_path.resolve(strict=True)),
            **metadata_hash,
        },
        "runtime_closure": {
            "contract": "sbf.sim-mujoco-runtime-closure/draft-1",
            "sha256": _closure_digest(entries),
            "entry_count": len(entries),
            "total_size_bytes": sum(item["size_bytes"] for item in entries),
            "entries": entries,
        },
        "native_library": {
            "path": native_rel,
            "sha256": by_path[native_rel]["sha256"],
            "size_bytes": by_path[native_rel]["size_bytes"],
        },
        "bindings": bindings,
        "claims": {
            "filesystem_inventory_verified": True,
            "wheel_record_reverified_against_installed_bytes": True,
            "mujoco_imported": False,
            "helper_executed": False,
            "mjcf_compiled": False,
            "execution_admitted": False,
        },
    }


def _message(exc: Exception) -> str:
    text = str(exc).replace("\n", " ").replace("\r", " ")
    return text[:1024] or "runtime inventory failed"


def main() -> int:
    try:
        request = _read_request()
        output = collect(request)
        sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        return 0
    except InventoryError as exc:
        sys.stdout.write(json.dumps({
            "schema": OUTPUT_SCHEMA,
            "status": "INVENTORY_FAILED",
            "error": {"code": exc.code, "message": _message(exc)},
        }, separators=(",", ":")) + "\n")
        return 1
    except Exception:
        sys.stdout.write(json.dumps({
            "schema": OUTPUT_SCHEMA,
            "status": "INVENTORY_FAILED",
            "error": {"code": "INVENTORY_INTERNAL_ERROR", "message": "runtime inventory failed closed"},
        }, separators=(",", ":")) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
