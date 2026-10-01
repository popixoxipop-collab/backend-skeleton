#!/usr/bin/env python3
"""Collect a file-system-only MuJoCo runtime inventory.

This collector never imports mujoco and never compiles a model. Run it with the
exact target Python launcher under -I -S -B and an empty environment.

stdin protocol:
  sbf.sim-mujoco-runtime-admission-collect/draft-1
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import sys
from typing import Any

REQUEST_PROTOCOL = "sbf.sim-mujoco-runtime-admission-collect/draft-1"
OUTPUT_SCHEMA = "sbf.sim-mujoco-runtime-inventory/draft-1"
TARGET = "SIM-mujoco"
MUJOCO_VERSION = "3.12.0"
DIST_INFO = "mujoco-3.12.0.dist-info"
RECORD_REL = f"{DIST_INFO}/RECORD"
METADATA_REL = f"{DIST_INFO}/METADATA"
NATIVE_REL = "mujoco/libmujoco.so.3.12.0"
REQUIRED_BINDINGS = (
    "mujoco/__init__.py",
    "mujoco/_enums.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_functions.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_specs.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_structs.cpython-312-x86_64-linux-gnu.so",
)
MAX_REQUEST_BYTES = 1024 * 1024
MAX_FILES = 20_000
MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024


class CollectError(Exception):
    pass


def fail(message: str) -> None:
    raise CollectError(message)


def exact_keys(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    actual = set(value.keys())
    extra = sorted(actual - keys)
    missing = sorted(keys - actual)
    if extra:
        fail(f"{label} contains unsupported fields: {', '.join(extra)}")
    if missing:
        fail(f"{label} is missing required fields: {', '.join(missing)}")
    return value


def absolute_path(value: Any, label: str, *, directory: bool | None = None) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        fail(f"{label} must be a non-empty absolute path")
    path = Path(value)
    if not path.is_absolute():
        fail(f"{label} must be absolute")
    if path.is_symlink():
        fail(f"{label} must not be a symlink")
    try:
        resolved = path.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        fail(f"{label} does not exist")
        raise AssertionError from exc
    if directory is True and not resolved.is_dir():
        fail(f"{label} must be a directory")
    if directory is False and not resolved.is_file():
        fail(f"{label} must be a regular file")
    return resolved


def logical_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 4096:
        fail(f"{label} must be a bounded relative POSIX path")
    if (
        "\\" in value
        or value.startswith("/")
        or ":" in value.split("/", 1)[0]
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        fail(f"{label} must be a normalized relative POSIX path")
    return value


def hash_file(path: Path) -> tuple[str, int]:
    if path.is_symlink():
        fail(f"symlink cannot be hashed as a trusted runtime file: {path}")
    stat = path.stat()
    if not path.is_file():
        fail(f"runtime entry is not a regular file: {path}")
    if stat.st_size > MAX_FILE_BYTES:
        fail(f"runtime file exceeds per-file byte limit: {path}")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), size


def canonical_hash(value: Any, domain: str = "") -> str:
    encoded = (
        domain
        + json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def classify_runtime_file(path: str) -> str:
    lower = path.lower()
    if path == NATIVE_REL:
        return "native"
    if path.startswith("mujoco/plugin/") and lower.endswith((".so", ".dylib", ".dll")):
        return "plugin"
    if lower.endswith((".so", ".pyd", ".dylib", ".dll")):
        return "extension"
    if f"/{DIST_INFO}/" in f"/{path}" or path.startswith(f"{DIST_INFO}/"):
        return "metadata"
    if lower.endswith((".py", ".pyi")):
        return "python"
    return "resource"


def inventory_tree(root: Path, prefix: str = "") -> tuple[list[dict[str, Any]], list[str]]:
    files: list[dict[str, Any]] = []
    symlinks: list[str] = []
    total = 0
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        directory_path = Path(directory)

        kept_dirs = []
        for name in sorted(dirnames):
            child = directory_path / name
            rel = child.relative_to(root).as_posix()
            logical = f"{prefix}/{rel}" if prefix else rel
            if child.is_symlink():
                symlinks.append(logical)
            else:
                kept_dirs.append(name)
        dirnames[:] = kept_dirs

        for name in sorted(filenames):
            child = directory_path / name
            rel = child.relative_to(root).as_posix()
            logical = f"{prefix}/{rel}" if prefix else rel
            if child.is_symlink():
                symlinks.append(logical)
                continue
            sha256, size = hash_file(child)
            total += size
            if total > MAX_TOTAL_BYTES:
                fail("runtime closure exceeds aggregate byte limit")
            kind = "stdlib" if prefix.startswith("python-stdlib-") else classify_runtime_file(rel)
            files.append({
                "path": logical,
                "sha256": sha256,
                "size_bytes": size,
                "kind": kind,
            })
            if len(files) > MAX_FILES:
                fail(f"runtime closure exceeds file-count limit {MAX_FILES}")
    return files, symlinks


def parse_record(runtime_root: Path) -> tuple[str, int, int, set[str]]:
    record = runtime_root / RECORD_REL
    record_sha, _ = hash_file(record)
    raw = record.read_text(encoding="utf-8")
    expected = 0
    verified = 0
    listed: set[str] = set()
    for row in csv.reader(io.StringIO(raw)):
        if len(row) != 3:
            fail("MuJoCo RECORD contains malformed row")
        rel, digest_spec, size_text = row
        rel = logical_path(rel, "RECORD path")
        listed.add(rel)
        target = runtime_root / Path(*rel.split("/"))
        if digest_spec:
            if not digest_spec.startswith("sha256="):
                fail(f"unsupported RECORD digest algorithm for {rel}")
            encoded = digest_spec[len("sha256="):]
            padding = "=" * ((4 - len(encoded) % 4) % 4)
            try:
                wanted = base64.urlsafe_b64decode(encoded + padding).hex()
            except Exception as exc:
                fail(f"invalid RECORD digest encoding for {rel}")
                raise AssertionError from exc
            expected += 1
            actual, size = hash_file(target)
            if actual != wanted:
                fail(f"RECORD digest mismatch for {rel}")
            if size_text:
                try:
                    wanted_size = int(size_text)
                except ValueError as exc:
                    fail(f"invalid RECORD size for {rel}")
                    raise AssertionError from exc
                if size != wanted_size:
                    fail(f"RECORD size mismatch for {rel}")
            verified += 1
        elif target.exists():
            # RECORD itself normally has no digest. Presence is still checked and
            # its exact bytes are bound by record_sha above.
            if target.is_symlink() or not target.is_file():
                fail(f"unhashed RECORD entry is not a regular file: {rel}")
    return record_sha, expected, verified, listed


def metadata_version(runtime_root: Path) -> str:
    metadata = runtime_root / METADATA_REL
    text = metadata.read_text(encoding="utf-8")
    versions = [
        line.split(":", 1)[1].strip()
        for line in text.splitlines()
        if line.startswith("Version:")
    ]
    if versions != [MUJOCO_VERSION]:
        fail(f"MuJoCo METADATA version must be exactly {MUJOCO_VERSION}")
    return versions[0]


def read_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        fail("collector request exceeds byte limit")
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, item in pairs:
            if key in out:
                fail(f"collector request contains duplicate JSON key: {key}")
            out[key] = item
        return out

    def reject_constant(value: str) -> Any:
        fail(f"collector request contains non-standard JSON number: {value}")

    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=reject_constant,
        )
    except UnicodeDecodeError as exc:
        fail("collector request must be valid UTF-8 JSON")
        raise AssertionError from exc
    except json.JSONDecodeError as exc:
        fail("collector request must be valid JSON")
        raise AssertionError from exc
    value = exact_keys(
        value,
        {
            "protocol",
            "target",
            "runtime_import_root",
            "helper_path",
            "wrapper_path",
            "stdlib_roots",
            "native_dependency_files",
        },
        "collector request",
    )
    if value["protocol"] != REQUEST_PROTOCOL or value["target"] != TARGET:
        fail("collector request protocol/target is invalid")
    return value


def main() -> int:
    try:
        request = read_request()

        if sys.flags.isolated != 1 or sys.flags.no_site != 1 or sys.flags.dont_write_bytecode != 1:
            fail("collector must run under python -I -S -B")
        runtime_root = absolute_path(
            request["runtime_import_root"], "runtime_import_root", directory=True
        )
        helper = absolute_path(request["helper_path"], "helper_path", directory=False)
        wrapper = absolute_path(request["wrapper_path"], "wrapper_path", directory=False)

        if not isinstance(request["stdlib_roots"], list) or not request["stdlib_roots"]:
            fail("stdlib_roots must be a non-empty array")
        stdlib_roots = [
            absolute_path(item, f"stdlib_roots[{index}]", directory=True)
            for index, item in enumerate(request["stdlib_roots"])
        ]

        if not isinstance(request["native_dependency_files"], list):
            fail("native_dependency_files must be an array")
        native_dependency_files: list[tuple[str, Path]] = []
        for index, item in enumerate(request["native_dependency_files"]):
            item = exact_keys(
                item, {"logical_path", "path"}, f"native_dependency_files[{index}]"
            )
            logical = logical_path(
                item["logical_path"], f"native_dependency_files[{index}].logical_path"
            )
            native_dependency_files.append(
                (
                    logical,
                    absolute_path(
                        item["path"],
                        f"native_dependency_files[{index}].path",
                        directory=False,
                    ),
                )
            )

        metadata_version(runtime_root)
        record_sha, record_expected, record_verified, record_listed = parse_record(
            runtime_root
        )

        site_files, site_symlinks = inventory_tree(runtime_root)
        files = list(site_files)
        symlinks = list(site_symlinks)

        for index, root in enumerate(stdlib_roots):
            entries, links = inventory_tree(root, prefix=f"python-stdlib-{index}")
            files.extend(entries)
            symlinks.extend(links)

        for logical, file_path in native_dependency_files:
            sha256, size = hash_file(file_path)
            files.append({
                "path": logical,
                "sha256": sha256,
                "size_bytes": size,
                "kind": "native",
            })

        files.sort(key=lambda entry: entry["path"])
        paths = [entry["path"] for entry in files]
        if len(paths) != len(set(paths)):
            fail("runtime inventory logical paths collide")

        by_path = {entry["path"]: entry for entry in site_files}
        package_actual = {
            path
            for path in by_path
            if path.startswith("mujoco/") or path.startswith(f"{DIST_INFO}/")
        }
        unlisted = sorted(package_actual - record_listed)

        native = by_path.get(NATIVE_REL)
        if not native or native["kind"] != "native":
            fail(f"required native library missing: {NATIVE_REL}")

        bindings = []
        for rel in REQUIRED_BINDINGS:
            entry = by_path.get(rel)
            if not entry:
                fail(f"required MuJoCo binding missing: {rel}")
            bindings.append({"path": rel, "sha256": entry["sha256"]})

        plugins = [
            {"path": entry["path"], "sha256": entry["sha256"]}
            for entry in site_files
            if entry["kind"] == "plugin"
        ]
        plugins.sort(key=lambda entry: entry["path"])

        proc_exe = Path("/proc/self/exe")
        if proc_exe.exists():
            launcher_resolved = proc_exe.resolve(strict=True)
        elif sys.executable:
            launcher_resolved = Path(sys.executable).resolve(strict=True)
        else:
            fail("could not resolve the exact Python launcher executable")
        launcher_sha, _ = hash_file(launcher_resolved)
        helper_sha, _ = hash_file(helper)
        wrapper_sha, _ = hash_file(wrapper)

        output = {
            "schema": OUTPUT_SCHEMA,
            "target": TARGET,
            "platform": f"{platform.system()}-{platform.machine()}",
            "python_version": platform.python_version(),
            "mujoco_version": MUJOCO_VERSION,
            "launcher": {
                "basename": launcher_resolved.name,
                "sha256": launcher_sha,
            },
            "helper": {"sha256": helper_sha},
            "wrapper": {"sha256": wrapper_sha},
            "runtime_closure": {
                "closure_sha256": canonical_hash(
                    files, "sbf.sim-mujoco-runtime-closure/draft-1\n"
                ),
                "record_sha256": record_sha,
                "record_entries_expected": record_expected,
                "record_entries_verified": record_verified,
                "unlisted_files": unlisted,
                "symlinks": sorted(symlinks),
                "files": files,
            },
            "native_library": {
                "path": NATIVE_REL,
                "sha256": native["sha256"],
            },
            "required_bindings": bindings,
            "plugin_libraries": plugins,
            "startup": {
                "isolated_flag": True,
                "no_site_flag": True,
                "dont_write_bytecode": True,
                "pth_processing_disabled": True,
                "runtime_import_root_explicit": True,
            },
        }
        sys.stdout.write(
            json.dumps(output, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            + "\n"
        )
        return 0
    except CollectError as exc:
        sys.stderr.write(f"M4_RUNTIME_INVENTORY_DENIED: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
