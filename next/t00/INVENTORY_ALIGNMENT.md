# T00-01 inventory alignment precondition

This optional, offline command checks whether a separately supplied proposed T23 inventory pins exactly the three heads of a recorded T00 baseline. It does not freeze heads, modify any input, approve T23 policy, or change an official verdict. This alignment command does not modify the committed observation, lock or inventory.

```
node next/t00/verify-inventory-alignment.mjs \
  --inventory-sha256 <independently-supplied-64-lowercase-hex> \
  <baseline.lock.json> <observation.json> <proposed-compatibility-inventory.json>
node --test next/t00/inventory-alignment.test.mjs
```

The expected inventory SHA-256 must come from the intended artifact's independently supplied pin. Computing it from an arbitrary file and immediately trusting that file provides no authenticity. The verifier compares and parses the same exact bytes; output identifies the byte count and SHA-256 of all three inputs.

Exit codes: 0 means the recorded inputs are coherent and their relevant inventory identities/heads align; 2 means validation failed; 1 means invalid CLI arguments or unreadable input. JSON is written only to stdout; usage/read errors go to stderr. Inputs are regular files bounded to 2 MiB each. Duplicate decoded JSON member names, invalid UTF-8 and nesting beyond 128 are rejected. Leaf symlinks are rejected where O_NOFOLLOW is available. Paths with spaces and non-ASCII names work. There is no network, subprocess, implicit path, file write, override, or re-pin operation.

## Checked fields

- Both strict-v1 `verifyBaseline(..., {remote: true})` and `verifyLockRecord` must pass. Remote-mode null dirty state is historical unknown cleanliness, not clean-worktree evidence. A true dirty state fails, and a nonboolean/non-null error state is also rejected.
- Historical inventory source metadata must identify the canonical BSKEL inventory path, expected pin field and locked BSKEL revision. The command does not fetch or authenticate those historical Git objects.
- Proposed inventory schema must be `bskel.scale-release-compatibility/3`. Its coordination baseline must explicitly record `state: ACCEPTED` and `accepted: true`. Those are input assertions, not newly granted authority.
- The coordination map has exactly three own keys: bskel, becoder, beval. The repository list has exactly one row per role, with canonical repository names and the locked default branches.
- Each coordination pin, repository `head_sha`, and repository `coordination_sha` is lowercase 40-hex and equals that role's locked head. Any mismatch rejects the whole report and emits no accepted repository subset.

## Historical inventory versus proposed inventory

The inventory inside `lock.inventory_pins` describes the old inventory read at the locked BSKEL commit. It is not replaced or silently reinterpreted. The proposed inventory can be carried in a later commit and pin those earlier locked heads. Requiring the proposed inventory's containing commit to equal its own BSKEL pin would create an impossible Git self-reference.

The checked-in historical lock and observation remain coherent. The actual current inventory differs from every locked head and therefore must fail this new alignment check. The test's aligned positive inventory is explicitly a synthetic in-memory fixture, not a real T23 freeze or a new production baseline.

## Limits and adoption

This checks exact supplied bytes, not current-main freshness or signer/coordinator identity. The strict-v1 recorded-CI coherence checks recognize allowed status/conclusion pairs but do not authenticate run/job results. The historical CLI remains unchanged. Historical failed CI remains legitimate evidence and is not rewritten into success. The command does not validate inventory promotion evidence, signature trust, full release-policy validity, required-check enforcement, private-repository attestation, independent approval, merge, MET, or release authorization.

The new test lives entirely under T00 ownership and is imported by `test/t00-baseline.test.mjs`, so the normal `npm test` command and root CI execute it. The command above also runs it independently. For the combined T00 suite, run `node --test test/t00-*.test.mjs` without separately listing the imported alignment suite. Test discovery does not make this precondition mandatory in a release workflow or establish a successful hosted CI run. T23 must separately produce an authorized frozen inventory with per-head CI evidence. Integrating this precondition into an authorized release workflow, exact-head CI/review/protected merge, and canonical T00 adjudication remain separate work.

The baseline implementation is the isolated [strict v1 candidate](BASELINE_STRICT_V1.md), not the preserved historical CLI.
