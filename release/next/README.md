# T23 release control — integrated-main rebaseline

Status: **REBASELINED_BLOCKED**.

This directory is release-control evidence only. It does not change the stable CLI, package allowlist, production registry, default writer, or published package version, and it grants no write privilege to any workflow. The one workflow-privilege difference is read-only: the `nested-next` CI job also holds `actions: read` (see the `--online` section).

Current integrated main anchors:

- backend-skeleton: `1cdd848a5aa97ff558c0574da70fedb899131ff7`
- backend-decoder: `0f0abcea1337335fc44b943932ad3c5f3fbaad6c`
- Backend-evaluation: `020668cdc2f5a836e78dfe05fd845ea58769a0e9`

T00-04A remains authoritative: legacy HTTP identity is the default/authoritative identity and T01 is additive. T01-06 is recorded as ACCEPTED on the T00 coordination record for additive consumer compatibility against the candidate pre-freeze identity-conformance pack only. That is not a final freeze, not signed evidence and not a release, and it is not a global next-writer cutover; no rollback material for T01-06 was found (see `test/contract-next/t01-compatibility-evidence.json` `current_state.not_established`).

These anchors were re-pinned on 2026-09-30 (T00-E) to the observed mains; they are pinned, not declared final-frozen. `compatibility-inventory.json` records the direct push CI run on each exact head. Release remains blocked: no check result is PASS because PASS requires T00-pinned, authority-signed evidence, T19-03 and T20-03 are not accepted, and the only rehearsal that exists (backend-evaluation `npm run test:release-rehearsal`) is a partial DB pointer-set rehearsal, not a full release/rollback rehearsal.

Run:

```bash
node --test release/next/test/release-policy.test.mjs
node release/next/release-policy.mjs verify release/next/compatibility-inventory.json release/next/release-plan.json release/next/evidence-manifest.json
```

Evidence references are resolved through `release/next/evidence-manifest.json`. A syntactically valid `sha256:...` string is never sufficient by itself: the verifier reads the referenced artifact bytes, recomputes SHA-256, and requires the artifact to bind the exact release check and all three current release-head SHAs.

Exit codes: `0` verified; `2` verification failed (the JSON verdict is on stdout; an unreadable or malformed evidence manifest counts as a failure and is reported as `EVIDENCE_STORE_INVALID`, and an inventory or release plan that is valid JSON of the wrong shape is reported as `INVENTORY_SCHEMA` or `RELEASE_PLAN_SCHEMA`); `1` usage error, or an inventory or release plan that cannot be read or parsed as JSON (message on stderr, nothing on stdout). A bare `null` in either of those two files also exits `1`, with a raw `TypeError` message instead of a verdict.

## Online check of the pinned CI runs (`--online`)

The default `verify` is offline and deterministic, so it cannot tell whether a recorded `ci_run` exists. `--online` adds one read-only `GET repos/<repo>/actions/runs/<ci_run>` per selected role and requires that the run exists, that `repository.full_name` is the role's pinned repository, that `event` is `push`, `head_branch` is `main`, `head_sha` equals `verification.ci_head_sha`, `status` is `completed` and `conclusion` is `success`. Failures exit `2` with `ONLINE_RUN_NOT_FOUND`, `ONLINE_RUN_MISMATCH` (naming the field), `ONLINE_RUN_UNAUTHORIZED`, `ONLINE_RUN_UNREACHABLE` or `ONLINE_RUN_RESPONSE_INVALID` (any other HTTP status, such as a redirect, or a reply that is not a JSON object). A pin that cannot be used for a selected role is reported before any request is made for that role, as `ONLINE_ROLE_MISSING` (no entry for the role), `ONLINE_REPOSITORY_NOT_PINNED`, `ONLINE_CI_RUN_INVALID` or `ONLINE_CI_HEAD_SHA_INVALID`; the offline inventory check reports the same defect.

Maintainer command, all three roles (needs a token that can read the private repositories' Actions runs):

```bash
GH_TOKEN="$(gh auth token)" node release/next/release-policy.mjs verify --online \
  release/next/compatibility-inventory.json \
  release/next/release-plan.json \
  release/next/evidence-manifest.json
```

- Flags go directly after `verify`, before the files. `--online-roles bskel[,becoder,beval]` (needs `--online`) limits the roles; the default is all three.
- The output has an `online` section that lists `checked_roles` and, explicitly, `not_checked_roles`.
- The token comes from `GH_TOKEN`, else `GITHUB_TOKEN`; it is never read from argv and never printed. It is optional for public repositories (it only avoids shared rate limits); without one, an exhausted anonymous rate limit answers `403` and is reported as `ONLINE_RUN_UNAUTHORIZED`, whose hint names a different cause.
- Network errors, `429` and `5xx` are retried (3 attempts, 15 s timeout each); every other failure is final.
- CI runs `--online --online-roles bskel`: `backend-decoder` and `Backend-evaluation` are private, and the workflow token gets `404` for their runs, the same answer GitHub gives for a run that does not exist. Those two roles are reported as not checked. The `nested-next` job's own `permissions` block (`contents: read`, `actions: read`) replaces the workflow-level one, so it repeats `contents: read`; the token reaches the verifier through the step's `env`, never argv.
- Not proved: that the run executed the intended workflow (its path and name are not checked), or that the recorded `package` and `workflow_blob` values match the repository.
- Not proved either: that the pinned run is current. Nothing compares `ci_head_sha` with the live head of `main`, so a genuine green run from weeks ago passes as long as the pins agree with it. `PLAN_MAIN_STALE` compares the plan with the inventory, not with GitHub.

## Promotion evidence needs an `evidence_ref`

A `promotion_evidence` entry that is ACCEPTED (required and observed) only removes its blocker when it carries a verified `evidence_ref`; without one `PROMOTION_EVIDENCE_REF_REQUIRED` is reported and the blocker stays:

- `{"kind": "file", "path": "<repo-relative path>", "sha256": "<64 hex>"}`: the file must be a regular file inside the repository (no absolute path, `.`, `..` or backslash; symlinks must resolve inside the repository) whose bytes hash to `sha256`; or
- `{"kind": "waiver", "waiver": {"id", "approved_by", "approved_on" (YYYY-MM-DD), "scope", "reason"}}`: shape-checked only, not authenticated. Waivers are listed in the output's `waived_evidence`.

Neither kind proves what the evidence says. A `file` ref proves that a file with that hash exists at that path; the verifier hashes its bytes but never interprets them, so any file in the repository (for instance `package.json` with its own hash) satisfies it. A `waiver` is checked for its five fields and for `approved_on` being a real calendar date, so a date in the future passes. A reviewer has to read the referenced file or the waiver.

`t01_06` points at `schemas/next/identity-conformance.json`. That pins the artifact. It does not pin the bskel 23/23 verifier run or the becoder/beval 12/12 replays, which stay narrative claims. `identity_conformance_sha256` (formerly `bskel_pack_sha256`) is checked against the same file, so any later edit of that file requires updating both hashes in `compatibility-inventory.json`. The pin is checked only when the key is present: deleting it is not an error, and if `t01_06` then carries a `waiver` ref, nothing pins the file any more.

`t01_06.current_rerun` in `compatibility-inventory.json` repeats the 23/23 and 12/12 checks on the mains of 2026-10-02 and gives the exact commands, including the command that checks the becoder and beval results together as a consumer set. It was run by one Claude Code session on one host; it is not an independent review and not signed evidence. Of the older narrative strings, four name an earlier anchor commit and five name none, so none of them is tied to the heads pinned in that file (see `narrative_claims_note`). In the re-run, the consumer commit inside each result is bound only as 40 lowercase hex characters (a zeroed commit was still accepted), and `execution.exit_code` and `execution.bskel_runtime_*` are constants written by the result builders, not observations. `verify` checks none of this.

The prerequisites T00-01, T00-04A, T00-05 and T01-06 in `release-plan.json` carry a `coordination_ref`. It names the exact commits and git blob SHAs of the control artifacts that exist only on the coordination branch `scale/T00/bootstrap-baseline` of `popixoxipop-collab/backend-skeleton` (they are not merged to main). `verify` ignores it, because it checks only `id`, `required_state` and `observed_state` of each prerequisite, so a wrong SHA, or a commit that no longer resolves (the branch force-pushed or deleted), is not detected. `coordination_ref_preservation` records which refs held the cited commits on 2026-10-02: for T00-05 and T01-06, besides the branch itself, the only fetched ref that held them was the head ref GitHub keeps for the closed PR 65, and how long GitHub keeps that ref was not established. `observed_state: ACCEPTED` on T00-05 is an inference from closeout fields, not a recorded state (see `coordination_ref_scope`). To check an entry: after `git fetch origin scale/T00/bootstrap-baseline`, `git rev-parse <commit>:<path>` prints the `blob`, and `git merge-base --is-ancestor <commit> <cited_at_tip>` exits 0.

## Authenticated release evidence

A content hash alone proves artifact integrity, not who produced the assertion. Release PASS evidence therefore requires an external T00-pinned Ed25519 authority.

Blocked-plan structural verification remains:

```bash
node release/next/release-policy.mjs verify \
  release/next/compatibility-inventory.json \
  release/next/release-plan.json \
  release/next/evidence-manifest.json
```

When PASS evidence exists, T00 must additionally supply an authority file and its independently pinned SHA-256 reference:

```bash
node release/next/release-policy.mjs verify \
  release/next/compatibility-inventory.json \
  release/next/release-plan.json \
  release/next/evidence-manifest.json \
  /path/outside/candidate/release-authority.json \
  sha256:<authority-file-sha256>
```

Every evidence artifact must be signed by a trusted key from that authority and must contain check-specific verifier fields. A self-authored JSON file with correct hashes and `PASS` text is insufficient.

Default activation is a distinct operation. Setting `default_activation_allowed=true` additionally requires a separately signed active `bskel.scale-default-activation-lease/1` bound to the exact three release heads:

```bash
... sha256:<authority-file-sha256> \
  /path/to/signed-default-activation-lease.json \
  <expected-fencing-token> \
  <expected-claim-id>
```

The release plan must also use `READY_FOR_RELEASE` when release is enabled, or `READY_FOR_DEFAULT_ACTIVATION` when default activation is enabled. `REBASELINED_BLOCKED` can never coexist with an enabled release.


The activation lease is accepted only when `issued_at <= now < expires_at`, the public key is Ed25519, and the signed lease's fencing token plus claim ID exactly match values independently pinned by T00. A still-unexpired older lease cannot survive a newer fencing epoch.
