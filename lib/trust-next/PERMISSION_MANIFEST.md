# Permission manifest RFC draft

`bskel.trust-permissions/1` is a fail-closed declaration consumed by later sandbox/runtime work. It is intentionally narrower than an OS sandbox policy and does not itself enforce syscalls or mounts.

Minimal manifest:

```json
{"schema":"bskel.trust-permissions/1"}
```

The minimal manifest denies filesystem reads/writes, network, process execution, environment access and secret use. It still carries bounded default wall/output limits for a future runner.

Example scoped manifest:

```json
{
  "schema": "bskel.trust-permissions/1",
  "read_roots": ["src", "package.json"],
  "write_roots": ["artifacts/t20"],
  "network": {"mode":"allowlist","allow":[{"host":"api.example.com","ports":[443]}]},
  "process": {"mode":"argv-allowlist","executables":["node"],"max_children":1},
  "environment": {"allow":["CI"]},
  "secret_refs": ["provider-token"],
  "limits": {"wall_ms":30000,"stdout_bytes":1048576,"stderr_bytes":1048576}
}
```

Rules:

- unknown fields are errors rather than silently ignored grants;
- roots are portable repository-relative POSIX paths and reject traversal/absolute/backslash forms;
- network grants are exact host+port pairs; wildcards and URLs are rejected;
- process grants identify executable basenames only; shell fragments and executable paths are rejected;
- environment entries are variable names only;
- `secret_refs` contain opaque names, never values or `NAME=value` strings;
- deny modes cannot simultaneously carry allowlist entries;
- deterministic normalization sorts/deduplicates declarative sets.

`compilePermissionPolicy()` provides pure decision helpers for unit testing and later runner integration. A `true` result means the manifest grants an operation; it does **not** prove the host OS prevented all other operations. T20-03 owns that enforcement boundary.


## Privilege-change review

`diffPermissionManifests(before, after)` compares two valid normalized manifests and reports deterministic `expansions` and `reductions`.

Expansions currently include:
- a broader read/write root;
- a new exact network host:port;
- a new executable;
- a larger child-process capacity;
- a newly inherited environment variable;
- a new secret reference;
- larger wall/stdout/stderr limits.

A nested root is understood as a subset: changing read access from `src` to `src/api` is a reduction, while the reverse is an expansion. Semantically equivalent input ordering or duplicate host/port declarations produces no delta.

This diff is an approval aid, not a runtime sandbox and not a signature format.

## Environment inheritance

`selectApprovedEnvironment(manifest, ambientEnv)` creates a new, frozen, null-prototype object containing only explicitly approved environment names. It does not mutate or return the original `process.env`.

Code-loading/injection variables such as `NODE_OPTIONS`, `PYTHONPATH`, `RUBYOPT`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, and Java option injection variables are rejected from the manifest. If a future first-party compiler profile genuinely needs one, that value must be runner-owned and separately reviewed rather than inherited from an untrusted repository/runtime request.

`secret_refs` are identifier-shaped map keys, not filesystem paths and not `NAME=value` strings. Secret resolution remains a later trust-boundary operation; this module never reads secret values.

## Known enforcement gaps

This layer deliberately does not claim to stop:
- symlink escapes inside an otherwise allowed repository-relative root;
- DNS rebinding or an allowed hostname resolving to loopback/private/link-local addresses;
- executable basename hijacking through an unsafe PATH;
- direct syscalls or inherited file descriptors;
- Docker/socket/device access;
- child-process descendants exceeding a policy unless the OS/runtime runner enforces it.

Those are T20-03 enforcement responsibilities and must be verified against the actual enforced runner profile after T00-04 freezes the shared interface.
