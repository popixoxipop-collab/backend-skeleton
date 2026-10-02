#!/usr/bin/env python3
"""T24 M4B Python stdlib native-extension dependency closure.

This producer reuses the exact Q4-approved M4A ELF/loader implementation from
native_dependency_resolver.py. It does not fork ELF parsing or DT_NEEDED
resolution semantics and does not import MuJoCo or execute target code.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys
import sysconfig
from types import ModuleType
from typing import Any

REQUEST_PROTOCOL = "sbf.sim-python-stdlib-native-dependency-resolve/draft-1"
OUTPUT_SCHEMA = "sbf.sim-python-stdlib-native-dependency-closure/draft-1"
TARGET = "SIM-mujoco"
ADMISSION_CANDIDATE_SHA = "ccf872caa35dc5947765eeb87436179f45b294c2"
M4A_CANDIDATE_SHA = "8b7c4977f4c212a4df28cae0fdc795f38796d901"
M4A_TREE_SHA = "b427b86cd7a2ead0ab7a16a5de0209f009f135c3"
M4A_RESOLVER_SHA256 = "08cfcbfeff4cd7d61c1617329544771a466716186190245bf1a868eefbb33ba3"
M4A_RESOLVER_SIZE = 29220

MAX_REQUEST_BYTES = 1024 * 1024
MAX_SEARCH_ROOTS = 32
MAX_NATIVE_EXTENSION_ROOTS = 8
MAX_STDLIB_NATIVE_SEEDS = 4096
MAX_UNION_NATIVE_FILES = 8192


class M4BError(Exception):
    pass


def fail(message: str) -> None:
    raise M4BError(message)


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
        fail("M4B request exceeds byte limit")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        fail("M4B request must be valid UTF-8")
        raise AssertionError from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=strict_object_pairs,
            parse_constant=reject_constant,
        )
    except json.JSONDecodeError as exc:
        fail("M4B request must be valid JSON")
        raise AssertionError from exc
    value = exact_keys(
        value,
        {
            "protocol",
            "target",
            "admission_candidate_sha",
            "m4a_candidate_sha",
            "m4a_tree_sha",
            "m4a_resolver_sha256",
            "search_roots",
        },
        "M4B request",
    )
    if value["protocol"] != REQUEST_PROTOCOL:
        fail("M4B protocol is invalid")
    if value["target"] != TARGET:
        fail("M4B target must be SIM-mujoco")
    if value["admission_candidate_sha"] != ADMISSION_CANDIDATE_SHA:
        fail("M4B request is not bound to the canonical M4 admission candidate")
    if value["m4a_candidate_sha"] != M4A_CANDIDATE_SHA:
        fail("M4B request is not bound to the Q4-approved M4A candidate")
    if value["m4a_tree_sha"] != M4A_TREE_SHA:
        fail("M4B request is not bound to the Q4-approved M4A tree")
    if value["m4a_resolver_sha256"] != M4A_RESOLVER_SHA256:
        fail("M4B request is not bound to the Q4-approved M4A resolver bytes")
    return value


def file_hash(path: Path) -> tuple[str, int]:
    stat = path.stat()
    if stat.st_size < 0 or stat.st_size > 2 * 1024 * 1024 * 1024:
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


def exact_regular_file_without_symlinks(path: Path, label: str) -> Path:
    requested = Path(path)
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
    if not resolved.is_file():
        fail(f"{label} must be a regular file")
    return resolved


def load_approved_m4a() -> tuple[ModuleType, Path, str, int]:
    path = exact_regular_file_without_symlinks(
        Path(__file__).absolute().with_name("native_dependency_resolver.py"),
        "Q4-approved M4A resolver",
    )
    sha256, size = file_hash(path)
    if sha256 != M4A_RESOLVER_SHA256 or size != M4A_RESOLVER_SIZE:
        fail("Q4-approved M4A resolver bytes do not match pinned identity")

    spec = importlib.util.spec_from_file_location("_t24_q4_approved_m4a", str(path))
    if spec is None or spec.loader is None:
        fail("could not construct import spec for Q4-approved M4A resolver")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if getattr(module, "ADMISSION_CANDIDATE_SHA", None) != ADMISSION_CANDIDATE_SHA:
        fail("Q4-approved M4A resolver admission binding is unexpected")
    return module, path, sha256, size


def configured_stdlib_roots(m4a: ModuleType) -> tuple[list[Path], list[Path]]:
    try:
        roots = m4a.stdlib_roots()
    except m4a.ResolveError as exc:
        fail(f"Q4-approved stdlib root resolver denied: {exc}")
    if not roots:
        fail("no configured stdlib roots")

    destshared_value = sysconfig.get_config_var("DESTSHARED")
    if not isinstance(destshared_value, str) or not destshared_value:
        fail("sysconfig DESTSHARED is unavailable")
    try:
        destshared = m4a.path_without_symlink_components(
            destshared_value,
            "sysconfig DESTSHARED",
            directory=True,
        )
    except m4a.ResolveError as exc:
        fail(f"Q4-approved path validator denied sysconfig DESTSHARED: {exc}")

    extension_roots: list[Path] = []
    for candidate in [destshared, *(root / "lib-dynload" for root in roots)]:
        try:
            candidate.lstat()
        except FileNotFoundError:
            continue
        except OSError:
            fail(f"could not inspect stdlib native-extension root: {candidate}")
        try:
            resolved = m4a.path_without_symlink_components(
                str(candidate),
                "stdlib native-extension root",
                directory=True,
            )
        except m4a.ResolveError as exc:
            fail(f"Q4-approved path validator denied native-extension root: {exc}")
        if not any(m4a.inside(resolved, root) or resolved == root for root in roots):
            fail(f"stdlib native-extension root escapes configured stdlib roots: {resolved}")
        if resolved not in extension_roots:
            extension_roots.append(resolved)

    if not extension_roots:
        fail("no stdlib native-extension roots resolved")
    if len(extension_roots) > MAX_NATIVE_EXTENSION_ROOTS:
        fail("stdlib native-extension root count exceeds limit")
    return roots, extension_roots


def native_extension_seeds(m4a: ModuleType, extension_roots: list[Path]) -> list[Path]:
    seeds: list[Path] = []
    seen: set[Path] = set()

    for root in extension_roots:
        def walk_error(exc: OSError) -> None:
            filename = getattr(exc, "filename", None)
            if isinstance(filename, str):
                try:
                    label = str(Path(filename).relative_to(root)) or "."
                except ValueError:
                    label = "<outside-native-extension-root>"
            else:
                label = "<unknown>"
            fail(f"stdlib native-extension traversal failed at {label}")

        for directory, dirnames, filenames in os.walk(
            root,
            topdown=True,
            onerror=walk_error,
            followlinks=False,
        ):
            current = Path(directory)
            checked_dirs: list[str] = []
            for name in sorted(dirnames):
                child = current / name
                if child.is_symlink():
                    fail(
                        "stdlib native-extension directory must not be a symlink: "
                        + str(child.relative_to(root))
                    )
                if not child.is_dir():
                    fail(
                        "stdlib native-extension directory entry must be a directory: "
                        + str(child.relative_to(root))
                    )
                checked_dirs.append(name)
            dirnames[:] = checked_dirs

            for name in sorted(filenames):
                child = current / name
                if child.is_symlink():
                    fail(
                        "stdlib native-extension file must not be a symlink: "
                        + str(child.relative_to(root))
                    )
                if not child.is_file():
                    fail(
                        "stdlib native-extension file entry must be regular: "
                        + str(child.relative_to(root))
                    )
                if not child.name.endswith(".so"):
                    continue
                try:
                    resolved = m4a.path_without_symlink_components(
                        str(child),
                        "stdlib native-extension seed",
                        directory=False,
                    )
                except m4a.ResolveError as exc:
                    fail(f"Q4-approved path validator denied stdlib-native seed: {exc}")
                if resolved not in seen:
                    seen.add(resolved)
                    seeds.append(resolved)
                    if len(seeds) > MAX_STDLIB_NATIVE_SEEDS:
                        fail("stdlib native-extension seed count exceeds limit")

    if not seeds:
        fail("no stdlib native-extension ELF seeds found")
    seeds.sort(key=str)
    return seeds


def exact_launcher_identity(m4a: ModuleType) -> dict[str, Any]:
    try:
        launcher = m4a.exact_launcher()
        sha256, size = m4a.file_hash(launcher)
    except m4a.ResolveError as exc:
        fail(f"Q4-approved launcher identity resolver denied: {exc}")
    return {
        "path": str(launcher),
        "sha256": sha256,
        "size_bytes": size,
    }


def resolve_stdlib_native_closure(
    m4a: ModuleType,
    stdlib_roots: list[Path],
    extension_roots: list[Path],
    search_roots: list[Path],
) -> dict[str, Any]:
    seeds = native_extension_seeds(m4a, extension_roots)
    seed_set = set(seeds)

    approved_roots: list[Path] = []
    for root in [*stdlib_roots, *extension_roots, *search_roots]:
        if root not in approved_roots:
            approved_roots.append(root)

    queue = list(seeds)
    visited: dict[Path, dict[str, Any]] = {}
    edges: list[dict[str, str]] = []
    interpreter_files: set[Path] = set()
    runtime_root = stdlib_roots[0]

    while queue:
        binary = queue.pop(0)
        if binary in visited:
            continue
        if len(visited) >= m4a.MAX_GRAPH_FILES:
            fail("stdlib native dependency graph exceeds file-count limit")

        try:
            dynamic = m4a.parse_elf_dynamic(binary)
        except m4a.ResolveError as exc:
            fail(f"Q4-approved ELF parser denied {binary}: {exc}")

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
            if not any(
                m4a.inside(interp_resolved, root) or interp_resolved == root
                for root in approved_roots
            ):
                fail(f"PT_INTERP resolves outside approved roots: {interp_resolved}")
            interpreter_files.add(interp_resolved)
            if interp_resolved not in visited and interp_resolved not in queue:
                queue.append(interp_resolved)

        needed_rows: list[dict[str, str]] = []
        for name in dynamic["needed"]:
            try:
                target = m4a.resolve_needed(
                    name,
                    binary,
                    dynamic,
                    runtime_root,
                    approved_roots,
                )
            except m4a.ResolveError as exc:
                fail(f"Q4-approved loader resolver denied {name} from {binary}: {exc}")
            needed_rows.append({"name": name, "path": str(target)})
            if len(edges) >= m4a.MAX_GRAPH_EDGES:
                fail("stdlib native dependency graph exceeds edge-count limit")
            edges.append({"from": str(binary), "needed": name, "to": str(target)})
            if target not in visited and target not in queue:
                queue.append(target)

        try:
            sha256, size = m4a.file_hash(binary)
        except m4a.ResolveError as exc:
            fail(f"Q4-approved file hasher denied {binary}: {exc}")
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

    external_paths = []
    for row in nodes:
        path = Path(row["path"])
        if any(m4a.inside(path, root) or path == root for root in stdlib_roots):
            continue
        external_paths.append(path)

    raw_native_dependency_files = []
    external_native_files = []
    for path in sorted(set(external_paths), key=str):
        try:
            logical_path = m4a.logical_native_path(path)
        except m4a.ResolveError as exc:
            fail(f"Q4-approved logical-path mapper denied {path}: {exc}")
        raw_native_dependency_files.append(
            {"logical_path": logical_path, "path": str(path)}
        )
        node = visited[path]
        external_native_files.append(
            {
                "logical_path": logical_path,
                "path": str(path),
                "sha256": node["sha256"],
                "size_bytes": node["size_bytes"],
            }
        )

    # Apply the same strict collision contract before M4B emits its own result,
    # not only later when M4A and M4B outputs are unioned.
    native_dependency_files = strict_native_dependency_union(
        [],
        raw_native_dependency_files,
    )
    external_by_path = {row["path"]: row for row in external_native_files}
    external_native_files = [
        external_by_path[row["path"]]
        for row in native_dependency_files
    ]

    seed_rows = [
        {
            "path": str(path),
            "sha256": visited[path]["sha256"],
            "size_bytes": visited[path]["size_bytes"],
        }
        for path in seeds
    ]

    return {
        "seeds": seed_rows,
        "nodes": nodes,
        "edges": edges,
        "native_dependency_files": native_dependency_files,
        "external_native_files": external_native_files,
    }


def strict_native_dependency_union(
    m4a_files: Any,
    m4b_files: Any,
) -> list[dict[str, str]]:
    sources = [
        ("M4A native_dependency_files", m4a_files),
        ("M4B native_dependency_files", m4b_files),
    ]
    logical_to_path: dict[str, str] = {}
    path_to_logical: dict[str, str] = {}

    for label, rows in sources:
        if not isinstance(rows, list):
            fail(f"{label} must be an array")
        if len(rows) > MAX_UNION_NATIVE_FILES:
            fail(f"{label} exceeds file-count limit")
        for index, row in enumerate(rows):
            row = exact_keys(row, {"logical_path", "path"}, f"{label}[{index}]")
            logical_path = row["logical_path"]
            native_path = row["path"]
            if (
                not isinstance(logical_path, str)
                or not logical_path.startswith("system-native/")
                or len(logical_path) > 8192
            ):
                fail(f"{label}[{index}].logical_path is invalid")
            if (
                not isinstance(native_path, str)
                or not native_path.startswith("/")
                or len(native_path) > 16384
                or "\x00" in native_path
            ):
                fail(f"{label}[{index}].path is invalid")

            previous_path = logical_to_path.get(logical_path)
            if previous_path is not None and previous_path != native_path:
                fail(f"native union logical_path collision: {logical_path}")

            previous_logical = path_to_logical.get(native_path)
            if previous_logical is not None and previous_logical != logical_path:
                fail(f"native union real-path collision: {native_path}")

            logical_to_path[logical_path] = native_path
            path_to_logical[native_path] = logical_path

    if len(logical_to_path) > MAX_UNION_NATIVE_FILES:
        fail("native union exceeds file-count limit")
    return [
        {"logical_path": logical_path, "path": logical_to_path[logical_path]}
        for logical_path in sorted(logical_to_path)
    ]


def main() -> int:
    try:
        if sys.flags.isolated != 1 or sys.flags.no_site != 1 or sys.flags.dont_write_bytecode != 1:
            fail("M4B producer must run under python -I -S -B")
        if platform.system() != "Linux" or platform.machine() != "x86_64":
            fail("M4B producer is pinned to Linux-x86_64")
        if not platform.python_version().startswith("3.12."):
            fail("M4B producer is pinned to Python 3.12.x")

        request = read_request()
        m4a, m4a_path, m4a_sha256, m4a_size = load_approved_m4a()

        if not isinstance(request["search_roots"], list) or not request["search_roots"]:
            fail("search_roots must be a non-empty array")
        if len(request["search_roots"]) > MAX_SEARCH_ROOTS:
            fail(f"search_roots exceeds limit {MAX_SEARCH_ROOTS}")
        search_roots: list[Path] = []
        for index, value in enumerate(request["search_roots"]):
            try:
                root = m4a.path_without_symlink_components(
                    value,
                    f"search_roots[{index}]",
                    directory=True,
                )
            except m4a.ResolveError as exc:
                fail(f"Q4-approved path validator denied search_roots[{index}]: {exc}")
            if root not in search_roots:
                search_roots.append(root)

        stdlib_roots, extension_roots = configured_stdlib_roots(m4a)
        launcher = exact_launcher_identity(m4a)
        closure = resolve_stdlib_native_closure(
            m4a,
            stdlib_roots,
            extension_roots,
            search_roots,
        )

        producer_path = exact_regular_file_without_symlinks(
            Path(__file__).absolute(),
            "M4B producer",
        )
        producer_sha256, producer_size = file_hash(producer_path)

        closure_payload = {
            "admission_candidate_sha": ADMISSION_CANDIDATE_SHA,
            "m4a_candidate_sha": M4A_CANDIDATE_SHA,
            "m4a_tree_sha": M4A_TREE_SHA,
            "m4a_resolver_sha256": m4a_sha256,
            "launcher": launcher,
            "stdlib_roots": [str(path) for path in stdlib_roots],
            "native_extension_roots": [str(path) for path in extension_roots],
            "seeds": closure["seeds"],
            "nodes": closure["nodes"],
            "edges": closure["edges"],
            "native_dependency_files": closure["native_dependency_files"],
            "external_native_files": closure["external_native_files"],
            "union_policy": {
                "schema": "sbf.sim-native-dependency-union-policy/draft-1",
                "identical_pair_deduplicated": True,
                "logical_path_collision_denied": True,
                "real_path_collision_denied": True,
                "max_files": MAX_UNION_NATIVE_FILES,
            },
        }

        output = {
            "schema": OUTPUT_SCHEMA,
            "target": TARGET,
            "platform": "Linux-x86_64",
            "python_version": platform.python_version(),
            "admission_candidate_sha": ADMISSION_CANDIDATE_SHA,
            "m4a_candidate_sha": M4A_CANDIDATE_SHA,
            "m4a_tree_sha": M4A_TREE_SHA,
            "m4a_resolver": {
                "path": str(m4a_path),
                "sha256": m4a_sha256,
                "size_bytes": m4a_size,
            },
            "launcher": launcher,
            "producer": {
                "sha256": producer_sha256,
                "size_bytes": producer_size,
            },
            **closure_payload,
            "closure_sha256": m4a.canonical_hash(
                closure_payload,
                "sbf.sim-python-stdlib-native-dependency-closure/draft-1\n",
            ),
            "claims": {
                "q4_approved_parser_reused": True,
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
    except (M4BError, OSError) as exc:
        sys.stderr.write(f"M4_STDLIB_NATIVE_DEPENDENCY_DENIED: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
