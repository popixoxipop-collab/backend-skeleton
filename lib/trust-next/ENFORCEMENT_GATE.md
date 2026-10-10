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
| listen | exact loopback host and port rule; the manifest spells an IPv6 host in brackets (`[::1]`) and the audit target keeps that spelling, but the host is handed the bare literal (`::1`), because a runtime looks a bracketed text up as a host name and the listener never opens | the granted pair |
| spawn | basename must be on the executable allowlist (no path separators, no shell syntax), the host resolves it to a pinned file, the environment is rebuilt from the approved names only, `max_children` bounds concurrency | the pinned file |
| environment, secret, device | named grant only; secret values never enter the audit | the grant |
| anything else | refused with `UNKNOWN_OPERATION` | none |

The default mode is `enforce`: a denied request throws `EnforcementDenied` (`code`
`PERMISSION_DENIED`) before any host method that has an effect is called.

### Public addresses

`classifyAddress` returns `public` only for global unicast that a registry has handed out, and refuses everything else by default.

- IPv4 is public unless it is in a private, shared (`100.64.0.0/10`), loopback, link-local, multicast (`224.0.0.0/4`) or reserved block, or
  in a row of the IANA IPv4 Special-Purpose Address Registry that is not globally reachable: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`,
  `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`,
  `198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4` and `255.255.255.255/32`. `192.88.99.0/24` (the deprecated 6to4 relay anycast block)
  has no flags at all in the registry, so it is not treated as reachable. The globally reachable rows `192.31.196.0/24`, `192.52.193.0/24`
  and `192.175.48.0/24` stay public.
- IPv6 is public only inside a block that the IANA IPv6 Global Unicast Address Assignments registry lists as `ALLOCATED` (the table
  `IPV6_ALLOCATED` in the gate) and outside the special-purpose space. Two `ALLOCATED` rows are special-purpose space and are not in the
  table: `2001::/23` (all of it) and `2002::/16`; `2001:db8::/32` (documentation) lies inside the APNIC block `2001:c00::/23` and is
  removed from it. Everything else is refused: the rows IANA lists as `RESERVED` (`2d00::/8` up to `3ffe::/16`, and `3fff::/20`), the
  ranges the registry does not list (`2000::/16`, the gaps between allocations, the space after the last allocation) and everything
  outside `2000::/3`, such as `::/128`, `::1/128`, `::ffff:0:0/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `100::/64`, `5f00::/16`, `fc00::/7`,
  `fe80::/10` and `ff00::/8`. An unknown range is never public by default.
- The IPv6 table is a dated snapshot, not a live lookup: the registry file downloaded on 2026-10-09 (its sha256 is cited in the gate). A
  block IANA allocates later is refused until the table is refreshed (the gate fails closed) or the manifest names the literal address.
  Refreshing means downloading the three registry files again, replacing them under `test/trust-next/iana-registries/`, updating their
  pins in `enforcement-gate-addresses.test.mjs` and the table in the gate; that test fails until the table agrees with the registry.
- The gate does not follow the registry's "globally reachable" flag where the row sits in space it refuses. IANA lists `64:ff9b::/96`,
  and inside `2001::/23` the rows `2001:1::1/128`, `2001:1::2/128`, `2001:1::3/128`, `2001:3::/32`, `2001:4:112::/48`, `2001:20::/28` and
  `2001:30::/28`, and for IPv4 `192.0.0.9/32` and `192.0.0.10/32` (inside `192.0.0.0/24`), as globally reachable. Those stay refused; a
  program that needs one of them is granted the exact literal address. The globally reachable IPv6 row `2620:4f:8000::/48` lies inside an
  allocated block and is public.
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

## Values the caller owns

Some requests carry a value that the caller still holds and can change while the gate waits: the argument list of a spawn, the bytes of
a write, the environment object, the manifest, the `timers` object. The gate copies each of them once, when the call is entered and
before its first await, and uses only the copy afterwards: for the check, for the audit record and for the call to the host. A change
made while the gate waits for the executable lookup or for the canonical path therefore changes neither what was checked nor what is
done.

- Spawn arguments are read once, element by element, into a frozen copy. A list of at most 1024 strings of at most 65536 characters
  each, without a NUL, is accepted. A value that is not an array, a longer list, a hole, an element that is not such a string and a list
  that cannot be read (a getter that throws, a revoked proxy) are refused as `INVALID_ARGUMENT`, which is recorded like any other
  refusal. `argc`, `args_sha256` and the list handed to `host.spawn` all come from that copy.
- Bytes to write are copied. A string is encoded as UTF-8 and counted in bytes; a `Uint8Array` (a `Buffer`, a resizable view) is copied.
  Bytes that cannot be read any more (a detached buffer, a revoked proxy) are refused as `INVALID_ARGUMENT`, never written as an empty
  file.
- The environment object of a spawn is read once, one read per allowed name, and only the approved copy reaches the host.
- The manifest is compiled at construction into a normalised, deep-frozen copy, so editing the object that was passed in changes neither
  the digest nor a decision.
- `setTimeout` and `clearTimeout` of the `timers` option are bound when the gate is built. Replacing them on the caller's object later does
  not switch the wall limit off.
- Captured child output is copied as it arrives, so a host that reuses its chunk buffer cannot change what the caller gets.
- `audit()` returns a new array of frozen entries and `report()` a frozen object, so editing a returned value does not change the log.

Not covered by a copy: the `host` object and what it returns are trusted and are used as they are when called (see the residual risks).
A getter that throws on the object passed to `invoke()`, or on the environment object of `readEnv`, is the caller's own error: it
propagates before any decision is written, so nothing is allowed and nothing is recorded.

## Limits

Enforced by the gate: `wall_ms` (the child is killed and the result says so), `stdout_bytes` and
`stderr_bytes` (output is cut at the cap, flagged as truncated, and the child is stopped).

A timer takes at most 2147483647 ms (about 24.8 days) and fires a longer delay after 1 ms, so a `wall_ms` above that is armed as a chain
of timers whose delays add up to the limit: the child is killed when the last one elapses and not before, and a child that ends earlier
clears the link that is armed at that moment. Each link is armed when the previous one fires, so the real time is the limit plus the
scheduling delay of every link. The manifest validator accepts any positive safe integer as `wall_ms` and was not changed. The gate takes an
optional `timers` object (`setTimeout` and `clearTimeout`, default the runtime ones; anything else is `INVALID_GATE_TIMERS`) so that the
chain can be tested with timers that do not wait. The gate binds the two functions when it is built.

Reported as `unsupported` because an in-process gate cannot enforce them: `cpu_ms`, `memory_bytes`,
`pids` and `scratch_bytes`. They stay in the manifest and in its digest, and an operating-system layer
must enforce them.

## When a step fails

One rule holds for every operation: fail closed. When a step fails after the host has started something (a child, a listener, a device, a
connection, a write), the gate stops what it can, records the failure, releases what it counted and rethrows the original error. The steps
that can fail are the methods of the host, the `timers` and the `clock` the gate was built with, the callback of `useSecret`, and the gate's
own bookkeeping (writing an outcome, clearing a timer, closing a handle). The first error is the one the caller gets. A later failure of a
step that the gate takes by itself (the log refusing an outcome, a timer that cannot be cleared, a `close()` that throws or rejects, a
`kill()` that throws, a `done` that rejects) is absorbed and never replaces it. An outcome is written at most once: a write that failed is
not retried, and something that happened is never recorded as failed.

| Operation | What the host may have started when a later step fails | What the gate does |
| --- | --- | --- |
| read, environment, secret | nothing that outlives the call (a secret that was already passed to `use` stays used) | records the failure and rethrows; nothing is held |
| write | a file | records the failure and rethrows; a file that was written stays written |
| connect | a connection | an answer that does not report `connected: true` fails as `NOT_CONNECTED`; that answer, and an answer that cannot be handed over because its outcome could not be written, is closed if it offers `close()`; a connection that offers no `close()` stays made |
| listen, device | a listener, a device handle | closed if it offers `close()` when the gate cannot hand it over; handed over unchanged when the outcome is written |
| spawn | a child | see below |

A host call that fails, or an answer that cannot be described (a read that is not bytes), is recorded as failed with the code of the error
(`HOST_ERROR` when the code cannot be read) and the error of the host is thrown. When the log refuses even that record, the error of the host
is still the one thrown: the decision is left without an outcome and `verifyAudit()` reports `AUDIT_OUTCOME_MISSING`. In shadow mode a
request that cannot be passed through is refused with `EnforcementDenied` in the same way.

**A spawn.** From the moment `host.spawn` returns a handle, the child counts toward `max_children` and its decision stays in flight until the
host reports it gone. A failure from then on (the wall timer cannot be armed, the next link of a long wall chain cannot be armed inside its
own timer callback, output cannot be read, a handle without `kill()` or `done`, a `done` that rejects) makes the gate, in this order:

1. kill the child, before it does anything that can throw, such as reading the clock or writing the outcome;
2. wait until the host reports the child gone (`done` settles, or rejects: a rejection is the host saying that it has nothing more to report);
3. clear the wall timer, ignoring an error from `clearTimeout`;
4. record the outcome as failed, with the code of the first error and `killed_for`, which names why the gate stopped the child: `gate_error`,
   or the limit that came first (`wall_ms`, `stdout_bytes`, `stderr_bytes`), which a later error does not overwrite; a host whose `spawn`
   threw has started nothing and gets no `killed_for`;
5. release the slot, whatever the earlier steps did;
6. rethrow the first error.

An error inside a timer callback or an output callback cannot be thrown into the timer or the host that runs it. The gate keeps it, stops
the child, and throws it from the request once the child is gone. A timer link that is still armed after the request has ended, because it
could not be cleared, does nothing when it fires. When the child ends on its own, its true outcome is written first and the wall timer is
cleared after it: a clock that fails then leaves the decision without an outcome (reported as missing), and a timer that cannot be cleared
leaves the outcome as it was written and is the error of the call. Neither turns a child that ran into a failed one.

What the gate cannot do, and states in `report().limits` (`host-effects-not-undone`):

- It cannot take back a write, and it cannot close a connection, a listener or a device handle that offers no `close()`. `close()` is best
  effort: its errors and rejections are ignored.
- A `kill()` that does not end the child leaves the request waiting, with its slot taken and its decision in flight
  (`report().audit.in_flight`), until the host reports the child gone. The gate sets no deadline on that report. When `done` rejects, the gate
  has killed the child and stops counting it; if that kill did not end it, the child may keep running unaccounted for.
- A handle without `done` cannot be waited for, so the gate kills it if it has `kill()` and releases the slot at once.
- A host call or a `use` callback that never settles keeps its slot and its decision in flight; only a child has a wall limit.

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

`verifyAuditLog(entries, { manifestDigest, expectedEntries, expectedHeadSha256, expectedMode, inFlight })` recomputes the chain and reports
tampering, truncation, a wrong head, a wrong seed, orphan outcomes, a missing outcome (`AUDIT_OUTCOME_MISSING`) and a repeated one
(`AUDIT_OUTCOME_DUPLICATE`): every `allow` or `would-deny` decision except an environment read must be followed by its outcome, and by
exactly one; a second outcome entry for the same decision is reported whether it agrees with the first or not. `inFlight` lists the decision numbers the caller
knows are still running. `gate.verifyAudit()` passes the decisions the gate is awaiting, and `report().audit.in_flight` is their
number; an exported log checked without `inFlight` must be complete. A decision whose outcome could not be written (a clock that
fails, for example) is no longer awaited and is reported as missing. The verifier takes `inFlight` on trust, so it proves a log
complete only when the caller passes none.

The verifier also checks that every decision has a shape the gate writes (`AUDIT_DECISION_REASONS`, exported). An `allow` carries the reason
`GRANTED`; a `deny` or `would-deny` carries one of the reasons the gate writes for that operation, and `would-deny` exists only for read,
write, connect, listen and spawn. An operation the gate does not know (a `chmod`, say) is only ever written as one `deny` with the reason
`UNKNOWN_OPERATION` and has no outcome; any other decision for it is `AUDIT_OPERATION_UNKNOWN`, so a re-chained log that holds an allowed
`chmod` with a matching outcome is rejected (the outcome is also an orphan). Environment reads, denials and unknown operations owe no
outcome, and an outcome entry must follow the decision it closes and name the same operation. A decision of a known operation in a shape
the gate does not write is `AUDIT_INCONSISTENT`. `enforcement-gate-decisions.test.mjs` checks the table against the real gate: one driver per pair makes the gate
write that pair, a sweep of more than 5000 requests against several hosts checks that every pair the gate wrote is in the table (a sweep
is evidence, not a proof that the table is complete), and the verifier is run on the cross product of operations, decisions and reasons
and accepts exactly the table.

One gate fixes its mode, its manifest and its contract when it is built, so the verifier binds the whole log to them. The manifest digest
seeds the chain (a log of another manifest breaks at its first entry) and every entry carries the contract. The mode is a field of every
entry, decision or outcome. The log is bound to `expectedMode` when the caller passes one (`gate.verifyAudit()` passes the gate's own
mode) and otherwise to the mode of the first entry that names a valid one. An entry of the other mode is `AUDIT_MODE_CHANGED`, so a
re-chained log in which an `enforce` decision is followed by a `shadow` one does not verify, even when both are environment reads that
owe no outcome. An `expectedMode` that is neither `enforce` nor `shadow` is `AUDIT_EXPECTED_MODE_INVALID`. A log whose entries all name
another mode than the one the caller knows the gate ran in is consistent with itself, so only the expectation can reject it. The time of
an entry must be a safe integer, which is all the gate promises of its clock (it refuses any other value with `INVALID_GATE_CLOCK`). Its
direction is deliberately not bound: a wall clock can step backwards, and the log of an honest gate must still verify. No entry carries a
gate identity or a version, and `maxAuditEntries` is not recorded in the log, so neither of them is bound.

The verifier does not look at targets (paths, addresses, ports, executables), at the fields of an outcome entry (`ok`, error codes, exit
codes), or at whether a decision agrees with the manifest: it is given the manifest digest, not the manifest. A re-chained log that
changes only those is accepted. It reads `entries` as plain data (a parsed log): entries that are accessors or proxies, or that change
between two reads, are not defended against.

The log proves consistency of what the gate recorded; it does not prove that the gate ran, and it is not signed.

## Known residual risks

- Time of check versus time of use: the canonical path is checked, then the host opens it. The test host
  opens without following a final symbolic link, which closes the swap of the last component, but a swap
  of a parent directory between check and open is not prevented by this module.
- The host binding is trusted. A host that ignores the pinned address, the pinned file or the approved
  environment defeats the gate. The gate looks the host's methods up when it calls them and does not copy what they return.
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
  one IPv6 address per special-purpose, reserved or unallocated block, listener rules including the host
  spelling of an IPv6 listener, spawn rules, shadow semantics including shadow connect without an address,
  hosts that do not affirm a connection, unknown operations).
- `test/trust-next/enforcement-gate-addresses.test.mjs`: the address classes checked against the three IANA registry files in
  `test/trust-next/iana-registries/` (pinned by hash): every row boundary, a sweep of the IPv6 and IPv4 space, and the globally
  reachable rows that stay refused. The expectations are computed from the registry rows, not from the gate's table.
- `test/trust-next/enforcement-gate-limits.test.mjs`: concurrency, output and wall limits, secrets,
  audit chain recomputation and tamper cases, audit capacity (no host call without two free slots,
  reservations held by running requests, outcomes removed from or repeated in a log), forged and re-chained
  logs (an allowed operation the gate does not know, outcomes of the wrong kind), report honesty, digest sensitivity.
- `test/trust-next/enforcement-gate-output.test.mjs`: the output caps against a scripted child that delivers several chunks: stdout and
  stderr are cut at the cap summed over chunks, flagged as truncated, and the child is stopped; output below the cap is returned whole and
  the child is not killed.
- `test/trust-next/enforcement-gate-wall.test.mjs`: the wall limit under injected timers, up to `Number.MAX_SAFE_INTEGER` ms (a chain
  of 4,194,305 links), the kill at the last link and not before, clearing of the armed link, refused timers. No real timer is awaited.
- `test/trust-next/enforcement-gate-decisions.test.mjs`: the table of decision shapes against the real gate (a driver per pair, a
  sweep of requests) and against the verifier (cross product of operations, decisions and reasons), outcome ownership and order.
- `test/trust-next/enforcement-gate-snapshots.test.mjs`: the values the caller owns. Spawn arguments and environment edited while the
  executable is resolved; holes, getters and revoked proxies in the argument list and its limits; write bytes edited, resized or detached
  while the path is canonicalised; timers replaced after construction; a host that reuses its output chunk; a manifest edited after
  construction; the values `audit()` returns.
- `test/trust-next/enforcement-gate-failures.test.mjs`: the failure rule. A wall timer that cannot be armed, armed again inside its own
  callback, or cleared; a clock that fails between the start of a child and its outcome; a kill that throws; a `done` that rejects; handles
  without `kill()` or `done`; a host whose spawn throws; read, write, connect, listen, secret and device with a failing host call, a failing
  log and a handle that cannot be handed over; a `close()` that throws, rejects or is absent; an answer that is not bytes; an error whose
  `code` cannot be read; shadow refusals when the log cannot record them. Timers, clock and children are scripted; no real timer is awaited.
- `test/trust-next/enforcement-gate-binding.test.mjs`: what a log is bound to. The mode (changed at every entry, decision or outcome, in
  both directions; entries of two real gates; `expectedMode`) and the time (a safe integer, direction not bound).
- `test/trust-next/enforcement-audit-forge.mjs`: helper, not a test. An independent re-implementation of the audit chain, used to
  recompute the gate's hashes and to re-chain an edited log so that only the content checks can reject it.
- `test/trust-next/enforcement-gate-real.test.mjs`: real symbolic links, loopback sockets (including an IPv6 `::1` listener where the
  machine has one) and child processes behind the gate, including positive controls.
- `test/trust-next/enforcement-gate-mutations.json`: executable mutants for the trust negative vectors,
  run by `test/conformance-next/product-mutation-runner.mjs`. `test/trust-next/enforcement-gate-mutations.test.mjs` guards the catalog:
  every anchor occurs once, vectors and test files exist, the file is byte-exact, and the catalog covers the values the caller owns,
  the properties the verifier binds a log to and the failure rule. A campaign result is a local run, not an attestation.
