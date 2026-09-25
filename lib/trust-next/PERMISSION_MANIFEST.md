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
