# T19 NEG-ROUTE-01 — computed Express mount, proposed cross-surface fix

**Draft only — ownership exception and independent review required.** This changes the unowned stable scanner `scanners/adapters/typescript-express.mjs` and one T19 negative test. The T00 ownership checker correctly returns `PATH_UNOWNED` for that scanner, so no owner/MET acceptance is claimed. The original T19-04 acceptance prohibits modifying other tracks without approval.

## Actual reproduced bug

For `app.use(getPrefix(),router)` followed by `router.get('/ping',handler)`, the original scanner emitted `GET /ping` as a concrete absolute endpoint. Because the mount prefix was computed, that route was **not provable**. It had skipped the unresolved mount and mistakenly treated its Router target as an unmounted root.

The proposal records dynamically mounted Router targets as unresolved, including relatively imported Router bindings; emits source-relative `computed-express-mount-prefix` signals; and prevents those targets and their descendants from being assigned a guessed empty root prefix. Routes reached by a separate **literal** mount remain emitted. It does not confuse dynamic middleware with Router targets or claim that any computed prefix is known.

## Evidence on protected-main source cc8c40ce (isolated D50 worktree)

| Executed test | Measured |
|---|---|
| Six new counterexamples before patch | RED: 2/6 pass, 4/6 fail |
| Same six after patch | GREEN: 6/6 pass |
| New + TS Express CLI/handles/shared/general scanner regressions | **196/196 PASS**, 0 failed/skipped/TODO |
| Track scope | Scanner PATH_UNOWNED (not bypassed) |
| Protected main/production/Tailnet release | Unchanged |

RED TAP SHA256 `d877e990761612ef7658f2fd540583440f5a7f42e8a2310968ad4839998c6a33`.
GREEN TAP SHA256 `c8e44ee38254585e1853e501104533b6c98d9a9f223265da91c57d38806bc231`.
196-case TAP SHA256 `3debbb462f815c44f2b800216d3a7f07104dda6d4aa98af4aeec02150b9ca1cb`.
Receipt SHA256 `7da111a498cf29e11a723f71024bfddf7e7201ff8f7f341710a10e3944724d10`.

Evidence root `/Volumes/D50/TailnetCommander/work/t19-route01-computed-mount-20261022/`.

## Admission limits

This is one concrete source-backed correction for original NEG-ROUTE-01, not all route predicates or dynamic routing patterns. A runtime Express listener is not exercised. No independent review or cross-surface path exception is granted by this note. Before protected main merge require explicit owner/coordinator exception, exact-head CI and reviewer approval, then actual merged-main replay. T19-04 remains PARTIAL, T00 r202 remains MET88/PARTIAL143/NOT_MET60, release remains BLOCKED.
