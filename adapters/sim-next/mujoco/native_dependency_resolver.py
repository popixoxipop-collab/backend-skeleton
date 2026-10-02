#!/usr/bin/env python3
"""T24 M4A Linux native dependency resolver.

Filesystem/ELF metadata only:
- does not import mujoco;
- does not execute subprocesses;
- does not invoke the dynamic loader;
- does not compile MJCF.

The resolver is intentionally pinned to Linux x86_64 ELF64 little-endian and
requires reviewer/server-owned search roots. Ambiguous or unresolved libraries
fail closed.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import struct
import sys
import sysconfig
from typing import Any

REQUEST_PROTOCOL = "sbf.sim-mujoco-native-dependency-resolve/draft-1"
OUTPUT_SCHEMA = "sbf.sim-mujoco-native-dependency-closure/draft-1"
TARGET = "SIM-mujoco"
MUJOCO_VERSION = "3.12.0"
ADMISSION_CANDIDATE_SHA = "ccf872caa35dc5947765eeb87436179f45b294c2"

MAX_REQUEST_BYTES = 1024 * 1024
MAX_SEARCH_ROOTS = 32
MAX_ELF_BYTES = 2 * 1024 * 1024 * 1024
MAX_DYNAMIC_ENTRIES = 65536
MAX_STRTAB_BYTES = 16 * 1024 * 1024
MAX_NEEDED_PER_FILE = 4096
MAX_GRAPH_FILES = 4096
MAX_GRAPH_EDGES = 65536
MAX_TEXT = 4096

ELF_MAGIC = b"\x7fELF"
ELFCLASS64 = 2
ELFDATA2LSB = 1
EM_X86_64 = 62

PT_LOAD = 1
PT_DYNAMIC = 2
PT_INTERP = 3

DT_NULL = 0
DT_NEEDED = 1
DT_STRTAB = 5
DT_STRSZ = 10
DT_RPATH = 15
DT_RUNPATH = 29

REQUIRED_NATIVE = "mujoco/libmujoco.so.3.12.0"
# This is not a general runtime search root. It models only the exact reviewed
# MuJoCo native object that is already part of the fixed seed set.
PINNED_RUNTIME_SONAMES = {
    "libmujoco.so.3.12.0": REQUIRED_NATIVE,
}
REQUIRED_EXTENSIONS = (
    "mujoco/_callbacks.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_constants.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_enums.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_errors.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_functions.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_render.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_specs.cpython-312-x86_64-linux-gnu.so",
    "mujoco/_structs.cpython-312-x86_64-linux-gnu.so",
)


class ResolveError(Exception):
    pass


def fail(message: str) -> None:
    raise ResolveError(message)


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    actual = set(value)
    extra = sorted(actual - expected)
    missing = sorted(expected - actual)
    if extra:
        fail(f"{label} contains unsupported fields: {', '.join(extra)}")
    if missing:
        fail(f"{label} is missing required fields: {', '.join(missing)}")
    return value


def strict_object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            fail(f"duplicate JSON key: {key}")
        out[key] = value
    return out


def reject_constant(value: str) -> Any:
    fail(f"non-standard JSON number: {value}")


def read_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        fail("resolver request exceeds byte limit")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        fail("resolver request must be valid UTF-8")
        raise AssertionError from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=strict_object_pairs,
            parse_constant=reject_constant,
        )
    except json.JSONDecodeError as exc:
        fail("resolver request must be valid JSON")
        raise AssertionError from exc
    value = exact_keys(
        value,
        {"protocol", "target", "admission_candidate_sha", "runtime_import_root", "search_roots"},
        "resolver request",
    )
    if value["protocol"] != REQUEST_PROTOCOL:
        fail("resolver protocol is invalid")
    if value["target"] != TARGET:
        fail("resolver target must be SIM-mujoco")
    if value["admission_candidate_sha"] != ADMISSION_CANDIDATE_SHA:
        fail("resolver request is not bound to the canonical M4 admission candidate")
    return value


def path_without_symlink_components(value: Any, label: str, *, directory: bool | None = None) -> Path:
    if not isinstance(value, str) or not value or len(value) > 16384 or "\x00" in value:
        fail(f"{label} must be a bounded absolute path")
    requested = Path(value)
    if not requested.is_absolute():
        fail(f"{label} must be absolute")

    current = Path(requested.anchor)
    for part in requested.parts[1:]:
        current = current / part
        try:
            current.lstat()
        except (FileNotFoundError, OSError) as exc:
            fail(f"{label} does not exist")
            raise AssertionError from exc
        if current.is_symlink():
            fail(f"{label} contains symlink component")

    try:
        resolved = requested.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        fail(f"{label} does not exist")
        raise AssertionError from exc
    if directory is True and not resolved.is_dir():
        fail(f"{label} must be a directory")
    if directory is False and not resolved.is_file():
        fail(f"{label} must be a regular file")
    return resolved


def file_hash(path: Path) -> tuple[str, int]:
    stat = path.stat()
    if stat.st_size < 0 or stat.st_size > MAX_ELF_BYTES:
        fail(f"file exceeds byte budget: {path}")
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


def read_exact(handle, offset: int, size: int, file_size: int, label: str) -> bytes:
    if offset < 0 or size < 0 or offset + size > file_size:
        fail(f"{label} is outside ELF file bounds")
    handle.seek(offset)
    data = handle.read(size)
    if len(data) != size:
        fail(f"{label} is truncated")
    return data


def vaddr_to_offset(vaddr: int, size: int, loads: list[tuple[int, int, int]], label: str) -> int:
    candidates = []
    for file_offset, virtual_address, file_size in loads:
        if vaddr >= virtual_address and vaddr + size <= virtual_address + file_size:
            candidates.append(file_offset + (vaddr - virtual_address))
    if len(candidates) != 1:
        fail(f"{label} cannot be mapped uniquely from ELF virtual address")
    return candidates[0]


def c_string(table: bytes, offset: int, label: str) -> str:
    if offset < 0 or offset >= len(table):
        fail(f"{label} offset is outside string table")
    end = table.find(b"\0", offset)
    if end < 0:
        fail(f"{label} is not NUL terminated")
    raw = table[offset:end]
    if len(raw) == 0 or len(raw) > MAX_TEXT:
        fail(f"{label} must be a bounded non-empty string")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        fail(f"{label} must be valid UTF-8")
        raise AssertionError from exc
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in text):
        fail(f"{label} contains control characters")
    return text


def parse_elf_dynamic(path: Path) -> dict[str, Any]:
    file_size = path.stat().st_size
    if file_size < 64:
        fail(f"ELF file is too small: {path}")
    with path.open("rb") as handle:
        header = read_exact(handle, 0, 64, file_size, "ELF header")
        ident = header[:16]
        if ident[:4] != ELF_MAGIC:
            fail(f"not an ELF file: {path}")
        if ident[4] != ELFCLASS64:
            fail(f"unsupported ELF class for {path}")
        if ident[5] != ELFDATA2LSB:
            fail(f"unsupported ELF endianness for {path}")
        if ident[6] != 1:
            fail(f"unsupported ELF ident version for {path}")

        (
            _ident,
            _etype,
            machine,
            version,
            _entry,
            phoff,
            _shoff,
            _flags,
            ehsize,
            phentsize,
            phnum,
            _shentsize,
            _shnum,
            _shstrndx,
        ) = struct.unpack("<16sHHIQQQIHHHHHH", header)
        if machine != EM_X86_64:
            fail(f"ELF machine must be x86_64 for {path}")
        if version != 1 or ehsize != 64 or phentsize != 56:
            fail(f"unsupported ELF64 header layout for {path}")
        if phnum <= 0 or phnum > 4096:
            fail(f"ELF program-header count is invalid for {path}")
        ph_bytes = read_exact(handle, phoff, phentsize * phnum, file_size, "ELF program headers")

        loads: list[tuple[int, int, int]] = []
        dynamic: tuple[int, int] | None = None
        interp: str | None = None
        for index in range(phnum):
            row = ph_bytes[index * phentsize : (index + 1) * phentsize]
            p_type, _p_flags, p_offset, p_vaddr, _p_paddr, p_filesz, _p_memsz, _p_align = struct.unpack(
                "<IIQQQQQQ", row
            )
            if p_type == PT_LOAD:
                if p_offset + p_filesz > file_size:
                    fail(f"PT_LOAD exceeds file bounds for {path}")
                loads.append((p_offset, p_vaddr, p_filesz))
            elif p_type == PT_DYNAMIC:
                if dynamic is not None:
                    fail(f"multiple PT_DYNAMIC segments are unsupported for {path}")
                if p_offset + p_filesz > file_size:
                    fail(f"PT_DYNAMIC exceeds file bounds for {path}")
                dynamic = (p_offset, p_filesz)
            elif p_type == PT_INTERP:
                if interp is not None:
                    fail(f"multiple PT_INTERP segments are unsupported for {path}")
                if p_filesz <= 1 or p_filesz > MAX_TEXT + 1:
                    fail(f"PT_INTERP size is invalid for {path}")
                raw = read_exact(handle, p_offset, p_filesz, file_size, "PT_INTERP")
                if not raw.endswith(b"\0"):
                    fail(f"PT_INTERP must be NUL terminated for {path}")
                try:
                    interp = raw[:-1].decode("utf-8", errors="strict")
                except UnicodeDecodeError as exc:
                    fail(f"PT_INTERP must be valid UTF-8 for {path}")
                    raise AssertionError from exc
                if any(ord(ch) < 32 or ord(ch) == 127 for ch in interp):
                    fail(f"PT_INTERP contains control characters for {path}")
                if not interp.startswith("/"):
                    fail(f"PT_INTERP must be absolute for {path}")

        if dynamic is None:
            return {"needed": [], "runpath": [], "rpath": [], "interp": interp}

        dyn_offset, dyn_size = dynamic
        if dyn_size % 16 != 0:
            fail(f"PT_DYNAMIC size is not aligned for {path}")
        dyn_count = dyn_size // 16
        if dyn_count > MAX_DYNAMIC_ENTRIES:
            fail(f"PT_DYNAMIC entry count exceeds limit for {path}")
        dyn_bytes = read_exact(handle, dyn_offset, dyn_size, file_size, "PT_DYNAMIC")

        needed_offsets: list[int] = []
        strtab_vaddr: int | None = None
        strtab_size: int | None = None
        runpath_offsets: list[int] = []
        rpath_offsets: list[int] = []
        terminated = False
        for index in range(dyn_count):
            tag, value = struct.unpack("<QQ", dyn_bytes[index * 16 : (index + 1) * 16])
            if tag == DT_NULL:
                terminated = True
                break
            if tag == DT_NEEDED:
                needed_offsets.append(value)
            elif tag == DT_STRTAB:
                if strtab_vaddr is not None and strtab_vaddr != value:
                    fail(f"multiple DT_STRTAB values are unsupported for {path}")
                strtab_vaddr = value
            elif tag == DT_STRSZ:
                if strtab_size is not None and strtab_size != value:
                    fail(f"multiple DT_STRSZ values are unsupported for {path}")
                strtab_size = value
            elif tag == DT_RUNPATH:
                runpath_offsets.append(value)
            elif tag == DT_RPATH:
                rpath_offsets.append(value)

        if not terminated:
            fail(f"PT_DYNAMIC has no DT_NULL terminator for {path}")
        if len(needed_offsets) > MAX_NEEDED_PER_FILE:
            fail(f"DT_NEEDED count exceeds limit for {path}")
        if len(runpath_offsets) > 1 or len(rpath_offsets) > 1:
            fail(f"multiple RPATH/RUNPATH entries are unsupported for {path}")

        if not needed_offsets and not runpath_offsets and not rpath_offsets:
            return {"needed": [], "runpath": [], "rpath": [], "interp": interp}
        if strtab_vaddr is None or strtab_size is None:
            fail(f"dynamic string table metadata is incomplete for {path}")
        if strtab_size <= 0 or strtab_size > MAX_STRTAB_BYTES:
            fail(f"dynamic string table size is invalid for {path}")
        strtab_offset = vaddr_to_offset(strtab_vaddr, strtab_size, loads, "DT_STRTAB")
        table = read_exact(handle, strtab_offset, strtab_size, file_size, "dynamic string table")

        needed = [c_string(table, offset, f"DT_NEEDED[{index}]") for index, offset in enumerate(needed_offsets)]
        if len(needed) != len(set(needed)):
            fail(f"duplicate DT_NEEDED entry for {path}")
        for name in needed:
            if "/" in name or "\\" in name:
                fail(f"slash-bearing DT_NEEDED is unsupported: {name}")

        def parse_paths(offsets: list[int], label: str) -> list[str]:
            if not offsets:
                return []
            text = c_string(table, offsets[0], label)
            values = text.split(":")
            if any(value == "" for value in values):
                fail(f"{label} contains an empty path element")
            return values

        return {
            "needed": needed,
            "runpath": parse_paths(runpath_offsets, "DT_RUNPATH"),
            "rpath": parse_paths(rpath_offsets, "DT_RPATH"),
            "interp": interp,
        }


def inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def expand_dynamic_dir(
    value: str,
    binary: Path,
    runtime_root: Path,
    approved_roots: list[Path],
) -> Path | None:
    expanded = value.replace("$" + "{ORIGIN}", str(binary.parent)).replace("$ORIGIN", str(binary.parent))
    if "$" in expanded:
        fail(f"unsupported dynamic-loader token in path: {value}")
    candidate = Path(expanded)
    if not candidate.is_absolute():
        fail(f"relative RPATH/RUNPATH is unsupported: {value}")

    # A wheel can retain an absolute build-time RUNPATH that is absent on the
    # target host. The dynamic loader cannot read bytes from a path that does
    # not exist, so it contributes no candidate to this observation. We still
    # inspect every existing prefix component and reject symlinked prefixes.
    # If the path later appears, a fresh resolver run will either admit it only
    # under the existing root policy or fail closed as outside approved roots.
    current = Path(candidate.anchor)
    for part in candidate.parts[1:]:
        current = current / part
        try:
            current.lstat()
        except FileNotFoundError:
            return None
        except OSError as exc:
            fail(f"dynamic search path cannot be inspected: {candidate}")
            raise AssertionError from exc
        if current.is_symlink():
            fail("dynamic search path contains symlink component")

    resolved = path_without_symlink_components(str(candidate), "dynamic search path", directory=True)
    allowed = [binary.parent, runtime_root, *approved_roots]
    if not any(inside(resolved, root) or resolved == root for root in allowed):
        fail(f"dynamic search path is outside approved roots: {resolved}")
    return resolved


def resolve_needed(
    name: str,
    binary: Path,
    dynamic: dict[str, Any],
    runtime_root: Path,
    approved_roots: list[Path],
) -> Path:
    dynamic_dirs: list[Path] = []
    source = dynamic["runpath"] if dynamic["runpath"] else dynamic["rpath"]
    for value in source:
        resolved = expand_dynamic_dir(value, binary, runtime_root, approved_roots)
        if resolved is not None and resolved not in dynamic_dirs:
            dynamic_dirs.append(resolved)

    roots = [*dynamic_dirs, *approved_roots]
    matches: list[Path] = []
    for root in roots:
        candidate = root / name
        if not candidate.exists():
            continue
        try:
            resolved = candidate.resolve(strict=True)
        except (FileNotFoundError, OSError):
            continue
        if not resolved.is_file():
            continue
        # Soname symlinks are normal on Linux, but their final real file must
        # remain inside the exact search root that admitted the name. A symlink
        # cannot turn an approved directory lookup into an arbitrary path read.
        if not (resolved == root or inside(resolved, root)):
            fail(f"DT_NEEDED {name} escapes approved search root {root}: {resolved}")
        if resolved not in matches:
            matches.append(resolved)

    # MuJoCo 3.12.0 bundled plugins are loaded after the package extension
    # modules and can name the exact libmujoco soname while carrying a stale
    # wheel build-time RUNPATH. Model only that one fixed, already-seeded
    # runtime object; this does not add runtime_root as a general search root.
    pinned_relative = PINNED_RUNTIME_SONAMES.get(name)
    if pinned_relative is not None:
        candidate = runtime_root / pinned_relative
        if candidate.exists():
            resolved = path_without_symlink_components(
                str(candidate),
                f"pinned runtime DT_NEEDED {name}",
                directory=False,
            )
            if not (resolved == runtime_root or inside(resolved, runtime_root)):
                fail(f"pinned runtime DT_NEEDED {name} escapes runtime root: {resolved}")
            if resolved not in matches:
                matches.append(resolved)

    if len(matches) == 0:
        fail(f"unresolved DT_NEEDED {name} from {binary}")
    if len(matches) > 1:
        fail(f"ambiguous DT_NEEDED {name} from {binary}: " + ", ".join(str(path) for path in matches))
    return matches[0]


def exact_launcher() -> Path:
    proc_exe = Path("/proc/self/exe")
    if not proc_exe.exists():
        fail("/proc/self/exe is unavailable")
    try:
        launcher = proc_exe.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        fail("could not resolve exact Python launcher")
        raise AssertionError from exc
    if not launcher.is_file():
        fail("exact Python launcher must resolve to a regular file")
    return launcher


def seed_files(runtime_root: Path, launcher: Path) -> list[Path]:
    seeds = [launcher, runtime_root / REQUIRED_NATIVE]
    seeds.extend(runtime_root / rel for rel in REQUIRED_EXTENSIONS)
    plugin_dir = runtime_root / "mujoco" / "plugin"
    if plugin_dir.exists():
        if plugin_dir.is_symlink() or not plugin_dir.is_dir():
            fail("mujoco/plugin must be a regular directory")
        def plugin_walk_error(exc: OSError) -> None:
            filename = getattr(exc, "filename", None)
            if isinstance(filename, str):
                try:
                    label = str(Path(filename).relative_to(plugin_dir)) or "."
                except ValueError:
                    label = "<outside-plugin-root>"
            else:
                label = "<unknown>"
            fail(f"plugin traversal failed at {label}")

        for directory, dirnames, filenames in os.walk(
            plugin_dir,
            topdown=True,
            onerror=plugin_walk_error,
            followlinks=False,
        ):
            current = Path(directory)
            checked_dirs = []
            for name in sorted(dirnames):
                child = current / name
                if child.is_symlink():
                    fail(
                        "plugin directory entry must not be a symlink: "
                        + str(child.relative_to(plugin_dir))
                    )
                if not child.is_dir():
                    fail(
                        "plugin directory entry must be a directory: "
                        + str(child.relative_to(plugin_dir))
                    )
                checked_dirs.append(name)
            dirnames[:] = checked_dirs
            for name in sorted(filenames):
                child = current / name
                if child.is_symlink():
                    fail(
                        "plugin file entry must not be a symlink: "
                        + str(child.relative_to(plugin_dir))
                    )
                if not child.is_file():
                    fail(
                        "plugin file entry must be regular: "
                        + str(child.relative_to(plugin_dir))
                    )
                if child.name.endswith(".so"):
                    seeds.append(child)
    out = []
    seen = set()
    for index, seed in enumerate(seeds):
        resolved = path_without_symlink_components(str(seed), f"seed[{index}]", directory=False)
        if resolved not in seen:
            seen.add(resolved)
            out.append(resolved)
    return out


def stdlib_roots() -> list[Path]:
    roots = []
    for key in ("stdlib", "platstdlib"):
        value = sysconfig.get_path(key)
        if not value:
            fail(f"sysconfig did not provide {key}")
        root = path_without_symlink_components(value, f"sysconfig {key}", directory=True)
        if root not in roots:
            roots.append(root)
    if not roots:
        fail("no Python stdlib roots resolved")
    return roots


def canonical_hash(value: Any, domain: str) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(domain.encode("utf-8") + payload + b"\n").hexdigest()


def logical_native_path(path: Path) -> str:
    token = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:16]
    name = path.name.replace("\\", "_").replace("/", "_")
    if not name:
        fail("native dependency basename is empty")
    return f"system-native/{token}-{name}"


def resolve_closure(
    runtime_root: Path,
    approved_roots: list[Path],
    launcher: Path,
) -> dict[str, Any]:
    queue = seed_files(runtime_root, launcher)
    seed_set = set(queue)
    visited: dict[Path, dict[str, Any]] = {}
    edges: list[dict[str, str]] = []
    interpreter_files: set[Path] = set()

    while queue:
        binary = queue.pop(0)
        if binary in visited:
            continue
        if len(visited) >= MAX_GRAPH_FILES:
            fail("native dependency graph exceeds file-count limit")
        dynamic = parse_elf_dynamic(binary)

        interp = dynamic["interp"]
        interp_resolved: Path | None = None
        if interp:
            try:
                interp_resolved = Path(interp).resolve(strict=True)
            except (FileNotFoundError, OSError) as exc:
                fail(f"PT_INTERP does not resolve: {interp}")
                raise AssertionError from exc
            if not interp_resolved.is_file():
                fail(f"PT_INTERP does not resolve to a regular file: {interp}")
            if not any(inside(interp_resolved, root) or interp_resolved == root for root in approved_roots):
                fail(f"PT_INTERP resolves outside approved roots: {interp_resolved}")
            interpreter_files.add(interp_resolved)
            if interp_resolved not in visited and interp_resolved not in queue:
                queue.append(interp_resolved)

        needed_rows = []
        for name in dynamic["needed"]:
            target = resolve_needed(name, binary, dynamic, runtime_root, approved_roots)
            needed_rows.append({"name": name, "path": str(target)})
            if len(edges) >= MAX_GRAPH_EDGES:
                fail("native dependency graph exceeds edge-count limit")
            edges.append({"from": str(binary), "needed": name, "to": str(target)})
            if target not in visited and target not in queue:
                queue.append(target)

        sha256, size = file_hash(binary)
        visited[binary] = {
            "path": str(binary),
            "sha256": sha256,
            "size_bytes": size,
            "seed": binary in seed_set,
            "needed": needed_rows,
            "runpath": dynamic["runpath"],
            "rpath": dynamic["rpath"],
            "interp": str(interp_resolved) if interp_resolved else None,
        }

    missing_interp = [path for path in interpreter_files if path not in visited]
    if missing_interp:
        fail(
            "PT_INTERP files were not traversed: "
            + ", ".join(str(path) for path in sorted(missing_interp, key=str))
        )

    nodes = sorted(visited.values(), key=lambda row: row["path"])
    edges.sort(key=lambda row: (row["from"], row["needed"], row["to"]))

    external = [
        Path(row["path"])
        for row in nodes
        if not inside(Path(row["path"]), runtime_root)
        and Path(row["path"]) != launcher
    ]
    native_dependency_files = [
        {"logical_path": logical_native_path(path), "path": str(path)}
        for path in sorted(set(external), key=str)
    ]

    return {
        "nodes": nodes,
        "edges": edges,
        "native_dependency_files": native_dependency_files,
    }


def main() -> int:
    try:
        if sys.flags.isolated != 1 or sys.flags.no_site != 1 or sys.flags.dont_write_bytecode != 1:
            fail("resolver must run under python -I -S -B")
        if platform.system() != "Linux" or platform.machine() != "x86_64":
            fail("resolver is pinned to Linux-x86_64")
        if not platform.python_version().startswith("3.12."):
            fail("resolver is pinned to Python 3.12.x")

        request = read_request()
        runtime_root = path_without_symlink_components(
            request["runtime_import_root"], "runtime_import_root", directory=True
        )
        if not isinstance(request["search_roots"], list) or not request["search_roots"]:
            fail("search_roots must be a non-empty array")
        if len(request["search_roots"]) > MAX_SEARCH_ROOTS:
            fail(f"search_roots exceeds limit {MAX_SEARCH_ROOTS}")
        roots = []
        for index, value in enumerate(request["search_roots"]):
            root = path_without_symlink_components(value, f"search_roots[{index}]", directory=True)
            if root not in roots:
                roots.append(root)

        launcher = exact_launcher()
        launcher_sha256, launcher_size = file_hash(launcher)
        closure = resolve_closure(runtime_root, roots, launcher)
        stdlib = [str(path) for path in stdlib_roots()]

        resolver_path = path_without_symlink_components(
            str(Path(__file__).absolute()),
            "native dependency resolver",
            directory=False,
        )
        resolver_sha256, resolver_size = file_hash(resolver_path)

        output = {
            "schema": OUTPUT_SCHEMA,
            "target": TARGET,
            "platform": "Linux-x86_64",
            "python_version": platform.python_version(),
            "mujoco_version": MUJOCO_VERSION,
            "admission_candidate_sha": ADMISSION_CANDIDATE_SHA,
            "launcher": {
                "path": str(launcher),
                "sha256": launcher_sha256,
                "size_bytes": launcher_size,
            },
            "resolver": {
                "sha256": resolver_sha256,
                "size_bytes": resolver_size,
            },
            "runtime_import_root": str(runtime_root),
            "search_roots": [str(path) for path in roots],
            "stdlib_roots": stdlib,
            "nodes": closure["nodes"],
            "edges": closure["edges"],
            "native_dependency_files": closure["native_dependency_files"],
            "closure_sha256": canonical_hash(
                {
                    "stdlib_roots": stdlib,
                    "nodes": closure["nodes"],
                    "edges": closure["edges"],
                    "native_dependency_files": closure["native_dependency_files"],
                },
                "sbf.sim-mujoco-native-dependency-closure/draft-1\n",
            ),
            "claims": {
                "elf_metadata_parsed": True,
                "launcher_native_closure_included": True,
                "subprocess_executed": False,
                "mujoco_imported": False,
                "helper_executed": False,
                "mjcf_compiled": False,
                "execution_admitted": False,
            },
        }
        sys.stdout.write(
            json.dumps(output, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            + "\n"
        )
        return 0
    except ResolveError as exc:
        sys.stderr.write(f"M4_NATIVE_DEPENDENCY_DENIED: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
