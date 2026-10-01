# T23 release control — integrated-main rebaseline

Status: **REBASELINED_BLOCKED**.

This directory is release-control evidence only. It does not change the stable CLI, package allowlist, production registry, default writer, or published package version, and it grants no write privilege to any workflow. The one workflow-privilege difference is read-only: the `nested-next` CI job also holds `actions: read` (see the `--online` section).

Current integrated main anchors:

- backend-skeleton: `1cdd848a5aa97ff558c0574da70fedb899131ff7`
- backend-decoder: `0f0abcea1337335fc44b943932ad3c5f3fbaad6c`
- Backend-evaluation: `020668cdc2f5a836e78dfe05fd845ea58769a0e9`

T00-04A remains authoritative: legacy HTTP identity is the default/authoritative identity and T01 is additive. T01-06 is accepted as a compatibility-shipping gate; it is not a global next-writer cutover.

These anchors were re-pinned on 2026-09-30 (T00-E) to the observed mains; they are pinned, not declared final-frozen. `compatibility-inventory.json` records the direct push CI run on each exact head. Release remains blocked: no check result is PASS because PASS requires T00-pinned, authority-signed evidence, T19-03 and T20-03 are not accepted, and the only rehearsal that exists (backend-evaluation `npm run test:release-rehearsal`) is a partial DB pointer-set rehearsal, not a full release/rollback rehearsal.

Run:

```bash
node --test release/next/test/release-policy.test.mjs
node release/next/release-policy.mjs verify release/next/compatibility-inventory.json release/next/release-plan.json release/next/evidence-manifest.json
```

Evidence references are resolved through `release/next/evidence-manifest.json`. A syntactically valid `sha256:...` string is never sufficient by itself: the verifier reads the referenced artifact bytes, recomputes SHA-256, and requires the artifact to bind the exact release check and all three current release-head SHAs.

Exit codes: `0` verified, `2` verification failed (the JSON verdict is on stdout), `1` usage or I/O error (message on stderr, nothing on stdout).

## Online check of the pinned CI runs (`--online`)

The default `verify` is offline and deterministic, so it cannot tell whether a recorded `ci_run` exists. `--online` adds one read-only `GET repos/<repo>/actions/runs/<ci_run>` per selected role and requires that the run exists, that `repository.full_name` is the role's pinned repository, that `event` is `push`, `head_branch` is `main`, `head_sha` equals `verification.ci_head_sha`, `status` is `completed` and `conclusion` is `success`. Failures exit `2` with `ONLINE_RUN_NOT_FOUND`, `ONLINE_RUN_MISMATCH` (naming the field), `ONLINE_RUN_UNAUTHORIZED` or `ONLINE_RUN_UNREACHABLE`.

Maintainer command, all three roles (needs a token that can read the private repositories' Actions runs):

```bash
GH_TOKEN="$(gh auth token)" node release/next/release-policy.mjs verify --online \
  release/next/compatibility-inventory.json \
  release/next/release-plan.json \
  release/next/evidence-manifest.json
```

- Flags go directly after `verify`, before the files. `--online-roles bskel[,becoder,beval]` (needs `--online`) limits the roles; the default is all three.
- The output has an `online` section that lists `checked_roles` and, explicitly, `not_checked_roles`.
- The token comes from `GH_TOKEN`, else `GITHUB_TOKEN`; it is never read from argv and never printed. It is optional for public repositories (it only avoids shared rate limits).
- Network errors, `429` and `5xx` are retried (3 attempts, 15 s timeout each); every other failure is final.
- CI runs `--online --online-roles bskel`: `backend-decoder` and `Backend-evaluation` are private, and the workflow token gets `404` for their runs, the same answer GitHub gives for a run that does not exist. Those two roles are reported as not checked. The `nested-next` job's own `permissions` block (`contents: read`, `actions: read`) replaces the workflow-level one, so it repeats `contents: read`; the token reaches the verifier through the step's `env`, never argv.
- Not proved: that the run executed the intended workflow (its path and name are not checked), or that the recorded `package` and `workflow_blob` values match the repository.

## Promotion evidence needs an `evidence_ref`

A `promotion_evidence` entry that is ACCEPTED (required and observed) only removes its blocker when it carries a verified `evidence_ref`; without one `PROMOTION_EVIDENCE_REF_REQUIRED` is reported and the blocker stays:

- `{"kind": "file", "path": "<repo-relative path>", "sha256": "<64 hex>"}`: the file must be a regular file inside the repository (no absolute path, `.`, `..` or backslash; symlinks must resolve inside the repository) whose bytes hash to `sha256`; or
- `{"kind": "waiver", "waiver": {"id", "approved_by", "approved_on" (YYYY-MM-DD), "scope", "reason"}}`: shape-checked only, not authenticated. Waivers are listed in the output's `waived_evidence`.

`t01_06` points at `schemas/next/identity-conformance.json`. That pins the artifact. It does not pin the bskel 23/23 verifier run or the becoder/beval 12/12 replays, which stay narrative claims. `identity_conformance_sha256` (formerly `bskel_pack_sha256`) is checked against the same file, so any later edit of that file requires updating both hashes in `compatibility-inventory.json`.

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
