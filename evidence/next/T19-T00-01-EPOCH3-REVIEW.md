# T19 independent review — T00-01 baseline epoch 3

Reviewed: 2026-09-25
Requested by: T00 coordination comment on PR #74
Reviewed target: backend-skeleton PR #97, T00-01 epoch 3
Disposition: **BLOCKED**

This review did not edit T00 files and does not certify framework support.

## Exact remote observations

| role | epoch-3 expected head | current main head | head verdict | package blob | lock blob | CI workflow blob | current exact-head CI |
|---|---|---|---|---|---|---|---|
| bskel | `5472a8b82655840d1d3ce76cb926987376e37ca6` | `5472a8b82655840d1d3ce76cb926987376e37ca6` | MATCH | `735a10bf6c274acb22759a620d57b3c5f2f69068` | `34da67575f01e97724c4b5ee944b67ae4435e003` | `11f5b42bd6bf409ef03d93bc7d89ae7e9bf31089` | run `36040486375` / #319 / push / completed success |
| becoder | `a575679b7d9e6df69c95c6c4f71cfdcf8e67c11e` | `37ffb1d8fab6a1e4485fb6b12515d5416963bc48` | **MISMATCH** | `fd1e7dbe09cb089ae2ab55b44a1731e55654e40b` | `043a1fe96bd338fe81909be195519b8cf402d66a` | `f8e0b6ccadbcd4b27972c1ba2ed42464cd8a79b4` | run `36083442722` / #83 / push / completed success |
| beval | `7a04cb705ca4cd162091d67fea5589e19fad163f` | `7a04cb705ca4cd162091d67fea5589e19fad163f` | MATCH | `714575e9cbaff966e4fc00138da6317ef84ac2a4` | `a83092968a5833883ac74c5e3aad5c80f117d006` | `c1ac2ad7dc8e32a9bfe2820d3a69452b12089ad3` | run `36083709046` / #868 / push / **queued**, conclusion null |

The required package/package-lock/CI-workflow blob identities recorded by epoch 3 still match the current remote heads for all three repositories. Blob identity does **not** cure the becoder head mismatch because the T00 policy independently requires the exact default-branch head.

## Becoder delta

`a575679b...` -> `37ffb1d8...` is 3 commits ahead, merge-base equal to `a575679b...`.

Current head commit:
- `37ffb1d8fab6a1e4485fb6b12515d5416963bc48`
- merge PR #9: "fix: emit canonical hierarchy collection in webgame repair manifest"
- changed files in the compare: `lib/webgame-repair-manifest.mjs`, `test/webgame-repair-manifest.test.mjs`

That change does not alter becoder package/package-lock/CI-workflow blob identities, but it does alter the repository snapshot and therefore invalidates epoch 3 under `requires_exact_head_sha=true`.

## Blocking reasons

1. **BECODER_HEAD_STALE** — epoch 3 pins `a575679b...`, but current main is `37ffb1d8...`.
2. **BEVAL_EXACT_HEAD_CI_PENDING** — current beval head matches, but exact-head push CI run `36083709046` (#868) is queued and must not be accepted as success.

Either reason independently blocks T00-01 acceptance.

## Required T00 action

Create a new rebaseline epoch using becoder main `37ffb1d8fab6a1e4485fb6b12515d5416963bc48`, retain the currently observed artifact blobs if re-read values remain identical, and capture the then-current exact-head CI for all three repos. If any main advances again, repeat rather than reusing this review.

T19 does not mark T00-01 ACCEPTED. T19-03 remains behind the T00-04/interface boundary; T19-01/T19-02-only work can continue under the existing ownership freeze.
