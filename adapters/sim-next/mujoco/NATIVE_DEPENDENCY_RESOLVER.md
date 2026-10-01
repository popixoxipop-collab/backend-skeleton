# T24 M4A native dependency resolver

Status: A1 support evidence producer / **not admission authority**.

The resolver exists to produce the explicit `stdlib_roots` and
`native_dependency_files` inputs consumed by the frozen M4 admission collector
in PR #195.

It is pinned to:

- Linux x86_64;
- Python 3.12.x;
- MuJoCo 3.12.0 reviewed native seed set.

It does not:

- import MuJoCo;
- execute subprocesses;
- call `ldd`;
- invoke the dynamic loader;
- execute the M3 helper;
- compile MJCF;
- issue T20/T16 admission.

## ELF surface

The parser accepts only ELF64 little-endian x86_64 and reads:

- `PT_LOAD`;
- `PT_DYNAMIC`;
- `PT_INTERP`;
- `DT_NEEDED`;
- `DT_STRTAB` / `DT_STRSZ`;
- `DT_RPATH` / `DT_RUNPATH`.

Unsupported class, endianness, machine, malformed offsets, duplicate
`DT_NEEDED`, slash-bearing dependency names, unsupported loader tokens,
relative RPATH/RUNPATH, unresolved dependency and ambiguous dependency all fail
closed.

## Seeds

The seed set is fixed by code to:

- `mujoco/libmujoco.so.3.12.0`;
- the eight reviewed CPython 3.12 native extension modules bound by #195;
- every regular `.so` directly under `mujoco/plugin`.

The Python `mujoco/__init__.py` binding remains part of #195's runtime closure,
but it is not an ELF seed.

## Search roots

The resolver request carries reviewer/server-owned absolute search roots. This is
not intended as a public caller-controlled interface.

RPATH/RUNPATH may add only:

- safe `$ORIGIN` / `${ORIGIN}` expansions;
- absolute directories that resolve under the binary directory or approved
  search roots.

Any other `$` loader token fails closed.

If the same soname resolves to more than one distinct real file across approved
roots, the resolver fails as ambiguous instead of guessing loader precedence.

## Output

Schema:

`sbf.sim-mujoco-native-dependency-closure/draft-1`

The output contains:

- exact stdlib/platstdlib roots from the isolated Python interpreter;
- ELF nodes with SHA-256, size, needed edges and path metadata;
- canonical dependency edges;
- exact external real files mapped to unique
  `system-native/<path-hash>-<basename>` logical paths;
- canonical closure SHA-256;
- explicit false claims for subprocess/MuJoCo/helper/MJCF/admission execution.

Only external native files are emitted in `native_dependency_files`; binaries
already under the runtime import root remain represented by #195's own runtime
inventory.

## Review boundary

This resolver requires its own independent review before its output may be used
for T20/T16 admission evidence. It does not change PR #195 and does not close
issue #197 by itself.
