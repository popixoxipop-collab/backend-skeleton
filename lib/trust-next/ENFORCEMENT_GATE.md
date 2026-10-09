# Permission enforcement gate (shadow/next)

Status: shadow/next entry, partly closed. This file is the limits record for `enforcement-gate.mjs`
(T20-03). It states what the gate does, what it does not do, and which spec lines stay unmet.

## What it is

`createEnforcementGate({ manifest, host, mode })` mediates every file, network, listener, process,
environment, secret and device request of untrusted code through one compiled
`bskel.trust-permissions/1` manifest (`permission-manifest.mjs`). It is cooperative, in-process
mediation: the caller must route its effects through the gate, and the gate performs them only through an
injected `host` object. The module itself holds no file, socket, process or environment capability
(`test/trust-next/static-purity.test.mjs` enforces that); real effects live in host bindings. The tests
use bindings in `test/trust-next/enforcement-host.mjs`.

## What it is not

- It is not an operating-system sandbox. A child that the gate starts is not confined by the gate: once
  started it can do whatever the operating system allows its user. The gate controls what is started, with
  which pinned file, argv and environment, and for how long.
- It is not an attestation and produces none. `report().attestation.present` is `false`, and
  `report().os_sandbox` is `false`.
- It does not set `enforced: true` anywhere. `trust-requirements.mjs` requires an evidence echo with
  `permission.enforced === true`; nothing in this change affirms that, so a gate result alone never
  satisfies `PERMISSION_NOT_ENFORCED`.

## Decisions

| Operation | Decision rule | Unit of use |
| --- | --- | --- |
| read, write | the lexical path must be inside a granted root; the host then returns the canonical path (symbolic links resolved, parent directory for a file that does not exist yet) and that canonical path must be inside the same grant | the canonical path |
| connect | exact host and port rule; the host name is resolved once, every answer must be public unless the literal address itself is granted, and the connection is made to the checked address, never to the name again | the pinned address |
| listen | exact loopback host and port rule | the granted pair |
| spawn | basename must be on the executable allowlist (no path separators, no shell syntax), the host resolves it to a pinned file, the environment is rebuilt from the approved names only, `max_children` bounds concurrency | the pinned file |
| environment, secret, device | named grant only; secret values never enter the audit | the grant |
| anything else | refused with `UNKNOWN_OPERATION` | none |

The default mode is `enforce`: a denied request throws `EnforcementDenied` (`code`
`PERMISSION_DENIED`) before any host method that has an effect is called.

## Shadow mode

In `shadow` mode a denial is recorded as `would-deny` and the request passes through, but only for
read, write, connect, listen and spawn. Environment, secret, device and unknown operations stay refused
in shadow mode, because passing them through would hand over a credential or a handle that cannot be
taken back. Shadow mode is for measuring a manifest before enforcing it, never for protection.

## Limits

Enforced by the gate: `wall_ms` (the child is killed and the result says so), `stdout_bytes` and
`stderr_bytes` (output is cut at the cap, flagged as truncated, and the child is stopped).
Reported as `unsupported` because an in-process gate cannot enforce them: `cpu_ms`, `memory_bytes`,
`pids` and `scratch_bytes`. They stay in the manifest and in its digest, and an operating-system layer
must enforce them.

## Audit

Every decision and every outcome is appended to a hash-chained log (`bskel.trust-enforcement-audit/1`),
bound to the permission digest of the whole manifest. `verifyAuditLog(entries, { manifestDigest,
expectedEntries, expectedHeadSha256 })` recomputes the chain and reports tampering, truncation, a wrong
head, a wrong seed and orphan outcomes. A full log fails closed (`AUDIT_FULL`). The log proves
consistency of what the gate recorded; it does not prove that the gate ran, and it is not signed.

## Known residual risks

- Time of check versus time of use: the canonical path is checked, then the host opens it. The test host
  opens without following a final symbolic link, which closes the swap of the last component, but a swap
  of a parent directory between check and open is not prevented by this module.
- The host binding is trusted. A host that ignores the pinned address, the pinned file or the approved
  environment defeats the gate.
- A started child can use any syscall, local socket, container socket or device the operating system
  allows. The gate does not see them.
- DNS: answers are pinned per request; a name that is rebound afterwards is not re-checked for traffic
  that a child opens by itself.

## Unmet spec lines

1. Enforcement is not wired into the scan/registry path. Those files belong to other tracks and were not
   edited. The entry is `lib/trust-next/enforcement-gate.mjs` and must be adopted by the scan and registry
   callers in their own changes.
2. No operating-system confinement and no attestation.
3. `cpu_ms`, `memory_bytes`, `pids` and `scratch_bytes` are not enforced.
4. The evidence echo field `permission.enforced` is not affirmed.

## Tests

- `test/trust-next/enforcement-gate.test.mjs`: policy decisions with a recording host (default deny,
  canonical paths, traversal, exact network rules, DNS rebinding, non-public addresses, listener rules,
  spawn rules, shadow semantics, unknown operations).
- `test/trust-next/enforcement-gate-limits.test.mjs`: concurrency, output and wall limits, secrets,
  audit chain recomputation and tamper cases, report honesty, digest sensitivity.
- `test/trust-next/enforcement-gate-real.test.mjs`: real symbolic links, loopback sockets and child
  processes behind the gate, including positive controls.
- `test/trust-next/enforcement-gate-mutations.json`: executable mutants for the trust negative vectors,
  run by `test/conformance-next/product-mutation-runner.mjs`.
