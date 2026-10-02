# T24 M4A native dependency resolver

Status: A1 support evidence producer / **not admission authority**.

The resolver exists to produce the explicit `stdlib_roots` and
`native_dependency_files` inputs consumed by the frozen M4 admission collector
in PR #209.

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

Unsupported class, endianness, machine, malformed offsets, multiple `PT_INTERP`, duplicate
`DT_NEEDED`, slash-bearing dependency names, unsupported loader tokens,
relative RPATH/RUNPATH, unresolved dependency and ambiguous dependency all fail
closed.

## Seeds

The seed set is fixed by code to:

- `mujoco/libmujoco.so.3.12.0`;
- the eight reviewed CPython 3.12 native extension modules bound by #209;
- every regular `.so` recursively under `mujoco/plugin`, with symlinked plugin files/directories rejected;
- any plugin-tree `scandir()`/walk error is fatal instead of silently omitting a subtree.

The Python `mujoco/__init__.py` binding remains part of #209's runtime closure,
but it is not an ELF seed.

## Search roots

The resolver request carries reviewer/server-owned absolute search roots. This is
not intended as a public caller-controlled interface.

RPATH/RUNPATH may add only:

- safe `$ORIGIN` / `${ORIGIN}` expansions;
- absolute directories that resolve under the binary directory or approved
  search roots.

An absolute RPATH/RUNPATH entry whose directory does not exist remains visible
in the ELF node metadata but is not admitted as a dependency search root.
Existing path prefixes are still inspected before the entry is skipped; a
symlink component or path-inspection error fails closed.

An existing absolute RPATH/RUNPATH directory outside the approved roots,
any relative path, and any other `# T24 M4A native dependency resolver

Status: A1 support evidence producer / **not admission authority**.

The resolver exists to produce the explicit `stdlib_roots` and
`native_dependency_files` inputs consumed by the frozen M4 admission collector
in PR #209.

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

Unsupported class, endianness, machine, malformed offsets, multiple `PT_INTERP`, duplicate
`DT_NEEDED`, slash-bearing dependency names, unsupported loader tokens,
relative RPATH/RUNPATH, unresolved dependency and ambiguous dependency all fail
closed.

## Seeds

The seed set is fixed by code to:

- `mujoco/libmujoco.so.3.12.0`;
- the eight reviewed CPython 3.12 native extension modules bound by #209;
- every regular `.so` recursively under `mujoco/plugin`, with symlinked plugin files/directories rejected;
- any plugin-tree `scandir()`/walk error is fatal instead of silently omitting a subtree.

The Python `mujoco/__init__.py` binding remains part of #209's runtime closure,
but it is not an ELF seed.

## Search roots

The resolver request carries reviewer/server-owned absolute search roots. This is
not intended as a public caller-controlled interface.

 loader token still fail closed.

If the same soname resolves to more than one distinct real file across approved
roots, the resolver fails as ambiguous instead of guessing loader precedence.

## Candidate and producer identity

Every request is bound to the canonical M4 admission candidate:

`ccf872caa35dc5947765eeb87436179f45b294c2`

The resolver hashes its own exact file bytes and includes that SHA-256 and size
in every successful output. A target-host deployment must still pin the expected
resolver bytes before execution; self-reporting alone is not review authority.

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
already under the runtime import root remain represented by #209's own runtime
inventory.

## Claim boundary

This M4A slice resolves the native dependency closure of:

- the exact running Python launcher resolved from `/proc/self/exe`;
- libmujoco;
- the reviewed CPython MuJoCo extension modules;
- bundled MuJoCo plugins.

The launcher itself is reported and SHA-bound, but is not duplicated in
`native_dependency_files` because #209 already binds launcher bytes separately.
Its external ELF dependencies and PT_INTERP target are included in the resolver
graph/output.

The resolver still does not claim that every possible stdlib extension module
will be imported by future code. #209 separately binds the complete configured
stdlib filesystem roots, while T20/T16 enforcement must preserve that exact
runtime environment.

## Review boundary

This resolver requires its own independent review before its output may be used
for T20/T16 admission evidence. It does not change PR #209 and does not close
issue #197 by itself.
