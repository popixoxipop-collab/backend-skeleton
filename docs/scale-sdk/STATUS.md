# T22 status — SDK / developer UX

Branch: `scale/t22/sdk-ux` · PR: #85 · owner scope: `sdk/next/**`, `docs/scale-sdk/**`,
`test/sdk-next/**`.

This status records T22's own scope. It does not mark package/CLI/security-executor integration as
complete.

| Task | T22 state | Evidence / remaining dependency |
|---|---|---|
| T22-01 user journey / diagnostics | implemented | discover→plan→scan→reconcile→contract→verify mapping and structured diagnostics docs |
| T22-02 minimal SDK | implemented | safe manifest builder/validator, worker protocol, nine JSON Schemas, schema catalog |
| T22-03 external adapter certification path | implemented through pre-execution boundary | manifest → explicit caller-injected conformance; actual untrusted execution requires T20-approved executor |
| T22-04 support/explain UX | implemented | support explanations + deterministic support evidence matrix; supported/partial/unsupported/unknown/not-applicable/conflict, provenance, conflict candidates, next actions, escaped Markdown |
| T22-05 editor/CI projection | implemented | SARIF 2.1.0 projection, unsafe absolute/traversal locations omitted |
| T22-06 onboarding | T22 portion implemented | task packet, package inventory review, composed submission review, source-tree fixture/E2E onboarding, docs; npm packaging/test-script/CLI wiring require integration/package owner |

## Fail-closed properties pinned by tests

- external manifest validation never grants execution
- network and subprocess permissions default to deny
- path traversal, absolute roots, URI-style paths and environment assignments are rejected
- protocol responses are bound to request id and adapter id
- no SDK module spawns a process, reads `process.env`, dynamically imports external code, or imports core internals
- SemVer prerelease precedence is handled; invalid leading-zero prerelease identifiers are rejected
- unknown/unsupported/not-applicable fields cannot carry an authoritative value
- conflict fields require at least two candidates and cannot simultaneously claim one authoritative value
- support Markdown escapes HTML/table control characters
- SARIF source locations cannot point outside the project using absolute/traversal/URI paths
- schema catalog IDs are checked against the nine JSON Schema files
- external package inventory rejects traversal, non-regular entries, reserved names, case/Unicode collisions
- package digest comparison is explicitly not archive-byte trust
- support evidence matrices are generated from explanations; contradictory support evidence becomes conflict
- submission review can only reach `ready-for-execution-review`, never executable

## Verification

EOE exact-worktree focused T22 suite after the SDK boundary defect fixes: **65/65 PASS** on Node 18, 22, and 24.

The corrective slice closes five reproduced defects without widening SDK authority:
- T20 injection-class inherited environment names (including `NODE_OPTIONS`) are rejected at T22 input validation;
- `snapshotRef` remains opaque but is bounded to 4096 UTF-8 bytes and rejects control characters;
- protocol/conformance JSON uses bounded depth/node/string/key/serialized-byte budgets, so one giant payload is fail-closed;
- conformance snapshots/freezes manifest, cases, and per-case requests before invoking caller code; its input digest is explicitly non-certifying;
- a non-legacy `supported` five-state projection rejects arbitrary string evidence refs and requires a T01 `sbf.artifact-ref/1` identity. T22 still does not verify artifact bytes itself or create a certification verdict.

The earlier branch head also passed the repository GitHub CI matrix, including Node test, package
install, Java/Python/Rails integration and DB lanes. Every later head must obtain its own CI result;
an older green run is not reused as proof for a newer commit.

## Deliberate blockers outside T22 ownership

1. `package.json#files` does not include `sdk/`, so this SDK is not shipped by npm yet.
2. the current `npm test` glob does not run `test/sdk-next/*.test.mjs`.
3. no new `bskel` CLI commands are wired.
4. the existing first-party adapter capability vocabulary/schema are unchanged; T22 consumes T03's five-state vocabulary as a projection only.
5. no untrusted external adapter execution path exists.
6. T23 shared integration has a central T22 nested-test lane, but no approved package candidate currently includes `sdk/next/**`; installed-package smoke remains T23-owned.

See `INTEGRATION.md` for the handoff requested from integration/package/security owners.
