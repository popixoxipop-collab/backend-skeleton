#!/usr/bin/env python3
"""Trusted M4 launcher wrapper.

The wrapper is runner-owned code. It must be invoked with:
  python -I -S -B runtime_wrapper.py RUNTIME_IMPORT_ROOT HELPER_PATH HELPER_SHA256

It does not import MuJoCo itself. It removes ambient import paths, adds exactly
one reviewed runtime import root, verifies helper bytes, then transfers control
to the already-reviewed M3 helper.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
import runpy
import sys
import sysconfig

SHA256_LEN = 64


def fail(message: str) -> "NoReturn":  # type: ignore[name-defined]
    raise SystemExit(f"M4_RUNTIME_WRAPPER_DENIED: {message}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def main() -> int:
    if len(sys.argv) != 4:
        fail("expected RUNTIME_IMPORT_ROOT HELPER_PATH HELPER_SHA256")

    if sys.flags.isolated != 1:
        fail("python isolated mode (-I) is required")
    if sys.flags.no_site != 1:
        fail("python no-site mode (-S) is required")
    if sys.flags.dont_write_bytecode != 1:
        fail("python no-bytecode mode (-B) is required")
    runtime_root = Path(sys.argv[1]).resolve(strict=True)
    helper_path = Path(sys.argv[2]).resolve(strict=True)
    helper_sha256 = sys.argv[3]

    if not runtime_root.is_dir():
        fail("runtime import root must be a directory")
    if not helper_path.is_file() or helper_path.is_symlink():
        fail("helper must be a regular non-symlink file")
    if (
        len(helper_sha256) != SHA256_LEN
        or any(ch not in "0123456789abcdef" for ch in helper_sha256)
    ):
        fail("helper SHA-256 is invalid")
    if sha256_file(helper_path) != helper_sha256:
        fail("helper bytes do not match approved SHA-256")

    # Preserve only the interpreter-owned standard library / dynload roots.
    # -I/-S keeps cwd/user-site/site-packages out, but recompute the boundary
    # explicitly so later Python changes cannot silently widen imports.
    base_prefix = Path(sys.base_prefix).resolve(strict=True)
    stdlib = Path(sysconfig.get_path("stdlib")).resolve(strict=True)
    platstdlib = Path(sysconfig.get_path("platstdlib")).resolve(strict=True)
    allowed = []
    for entry in sys.path:
        if not entry:
            continue
        try:
            resolved = Path(entry).resolve(strict=True)
        except (FileNotFoundError, OSError):
            continue
        if (
            inside(resolved, base_prefix)
            and (inside(resolved, stdlib) or inside(resolved, platstdlib))
        ):
            value = str(resolved)
            if value not in allowed:
                allowed.append(value)

    if not allowed:
        fail("no interpreter-owned standard-library import roots resolved")

    runtime_value = str(runtime_root)
    if runtime_value in allowed:
        fail("runtime import root must be distinct from interpreter stdlib roots")

    # Runtime root goes last so it cannot shadow the interpreter standard library.
    sys.path[:] = [*allowed, runtime_value]
    sys.dont_write_bytecode = True

    # The helper receives its original stdin/stdout contract unchanged.
    runpy.run_path(str(helper_path), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
