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
| connect | exact host and port rule; the host name is resolved once, every answer must be public (see Public addresses) unless the literal address itself is granted, and the connection is made to the checked address, never to the name again; a connection counts as made only when the host answers `{ connected: true }` | the pinned address |
| listen | exact loopback host and port rule | the granted pair |
| spawn | basename must be on the executable allowlist (no path separators, no shell syntax), the host resolves it to a pinned file, the environment is rebuilt from the approved names only, `max_children` bounds concurrency | the pinned file |
| environment, secret, device | named grant only; secret values never enter the audit | the grant |
| anything else | refused with `UNKNOWN_OPERATION` | none |

The default mode is `enforce`: a denied request throws `EnforcementDenied` (`code`
`PERMISSION_DENIED`) before any host method that has an effect is called.

### Public addresses

`classifyAddress` returns `public` only for global unicast and refuses everything else by default.

- IPv4 is public unless it is in a private, shared (100.64.0.0/10), loopback, link-local, documentation, benchmarking, multicast or reserved block.
- IPv6 is public only inside `2000::/3` and outside the special-purpose blocks that sit in it: `2001::/23` (all of it, although a few
  sub-blocks of it are globally reachable), `2001:db8::/32`, `2002::/16` and `3fff::/20`. Nothing outside `2000::/3` is public, so
  `::/128`, `::1/128`, `::ffff:0:0/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `100::/64`, `5f00::/16`, `fc00::/7`, `fe80::/10`, `ff00::/8`
  and every range that is unassigned or assigned later are refused until the manifest names the literal address.
- An IPv6 address that only wraps an IPv4 address (IPv4-mapped, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) is never public, even when the
  wrapped IPv4 address is. Its class is the class of the wrapped address when that is not public (`private`, `loopback`, ...) and
  `reserved` otherwise. IANA lists `64:ff9b::/96` as globally reachable; the gate does not follow that flag, because where a translator
  sends the traffic is decided outside the gate. A deployment that must reach hosts through DNS64 grants the literal addresses.

## Shadow mode

In `shadow` mode a denial is recorded as `would-deny` and the request passes through, but only for
read, write, connect, listen and spawn. Environment, secret, device and unknown operations stay refused
in shadow mode, because passing them through would hand over a credential or a handle that cannot be
taken back. Shadow mode is for measuring a manifest before enforcing it, never for protection.

A shadow `connect` needs an address to pass through to. For a host name the manifest does not grant, the gate resolves the name once
(`host.resolve`), pins the first answer and connects to it like it does for a granted name; a literal address is used as it is. When
there is no address (the host has no resolver, the name does not resolve, the literal is malformed) nothing is passed through: the host
is not called, the outcome of the `would-deny` decision is recorded as failed with the reason (`RESOLVE_FAILED`,
`HOST_CAPABILITY_MISSING` or `INVALID_ADDRESS_LITERAL`) and the caller gets `EnforcementDenied`. A connect that was not made is never
recorded as executed. In enforce mode an ungranted name is refused before it is resolved. In both modes a host answer other than
`{ connected: true }` is a failed outcome with `NOT_CONNECTED` and an error for the caller.

## Limits

Enforced by the gate: `wall_ms` (the child is killed and the result says so), `stdout_bytes` and
`stderr_bytes` (output is cut at the cap, flagged as truncated, and the child is stopped).
Reported as `unsupported` because an in-process gate cannot enforce them: `cpu_ms`, `memory_bytes`,
`pids` and `scratch_bytes`. They stay in the manifest and in its digest, and an operating-system layer
must enforce them.

## Audit

Every decision and every outcome is appended to a hash-chained log (`bskel.trust-enforcement-audit/1`),
bound to the permission digest of the whole manifest.

Capacity is reserved before the host is asked to do anything. The gate counts the entries already written plus one slot for every
decision that still waits for its outcome. A request other than an environment read is refused with `AUDIT_FULL` unless two slots are
free, one for its decision and one for its outcome; an environment read has no host effect and needs one slot, and a refusal needs
one. The check at the start of a request stops even the lookups that precede a decision (canonicalisation, name resolution,
executable lookup). The binding check is made where the decision is appended, with no await between the check and the append, so
concurrent requests cannot overrun the log: under concurrency a lookup can still precede an `AUDIT_FULL` refusal, but an effect (read,
write, connect, listen, spawn, secret, device) never starts without its outcome slot. A full log lets nothing through, and an
`AUDIT_FULL` refusal is itself not recorded when no slot is left. `maxAuditEntries` is at least 2.

`verifyAuditLog(entries, { manifestDigest, expectedEntries, expectedHeadSha256, inFlight })` recomputes the chain and reports
tampering, truncation, a wrong head, a wrong seed, orphan outcomes and a missing outcome (`AUDIT_OUTCOME_MISSING`): every `allow` or
`would-deny` decision except an environment read must be followed by its outcome. `inFlight` lists the decision numbers the caller
knows are still running. `gate.verifyAudit()` passes the decisions the gate is awaiting, and `report().audit.in_flight` is their
number; an exported log checked without `inFlight` must be complete. A decision whose outcome could not be written (a clock that
fails, for example) is no longer awaited and is reported as missing. The verifier takes `inFlight` on trust, so it proves a log
complete only when the caller passes none.

The log proves consistency of what the gate recorded; it does not prove that the gate ran, and it is not signed.

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
  canonical paths, traversal, exact network rules, DNS rebinding, non-public addresses with a table of
  one IPv6 address per special-purpose block and a sweep of the IPv6 space, listener rules, spawn rules,
  shadow semantics including shadow connect without an address, hosts that do not affirm a connection,
  unknown operations).
- `test/trust-next/enforcement-gate-limits.test.mjs`: concurrency, output and wall limits, secrets,
  audit chain recomputation and tamper cases, audit capacity (no host call without two free slots,
  reservations held by running requests, outcomes removed from a log), report honesty, digest sensitivity.
- `test/trust-next/enforcement-gate-real.test.mjs`: real symbolic links, loopback sockets and child
  processes behind the gate, including positive controls.
- `test/trust-next/enforcement-gate-mutations.json`: executable mutants for the trust negative vectors,
  run by `test/conformance-next/product-mutation-runner.mjs`.
