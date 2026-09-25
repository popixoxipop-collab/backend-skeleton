# T19 independent review — T00-01 baseline epoch 4 / PR #100

Reviewed: 2026-09-25
Requested by: T00 coordination comment on PR #74
Reviewed target: backend-skeleton PR #100
Disposition: **BLOCKED**

T19 did not edit T00 files and this review does not certify framework support.

## 1. Current default-branch heads

| role | expected by epoch 4 | current main | verdict |
|---|---|---|---|
| bskel | `5472a8b82655840d1d3ce76cb926987376e37ca6` | `5472a8b82655840d1d3ce76cb926987376e37ca6` | MATCH |
| becoder | `37ffb1d8fab6a1e4485fb6b12515d5416963bc48` | `37ffb1d8fab6a1e4485fb6b12515d5416963bc48` | MATCH |
| beval | `7a04cb705ca4cd162091d67fea5589e19fad163f` | `7a04cb705ca4cd162091d67fea5589e19fad163f` | MATCH |

## 2. Required artifact blob identities

All epoch-4 recorded package/package-lock/CI-workflow blobs match the current exact heads.

| role | package.json | package-lock.json | .github/workflows/ci.yml |
|---|---|---|---|
| bskel | `735a10bf6c274acb22759a620d57b3c5f2f69068` | `34da67575f01e97724c4b5ee944b67ae4435e003` | `11f5b42bd6bf409ef03d93bc7d89ae7e9bf31089` |
| becoder | `fd1e7dbe09cb089ae2ab55b44a1731e55654e40b` | `043a1fe96bd338fe81909be195519b8cf402d66a` | `f8e0b6ccadbcd4b27972c1ba2ed42464cd8a79b4` |
| beval | `714575e9cbaff966e4fc00138da6317ef84ac2a4` | `a83092968a5833883ac74c5e3aad5c80f117d006` | `c1ac2ad7dc8e32a9bfe2820d3a69452b12089ad3` |

## 3. Exact-head CI observed

- bskel main: run `36040486375` / #319 / push / completed **success**
- becoder main: run `36083442722` / #83 / push / completed **success**
- beval main: run `36083709046` / #868 / push / **queued**, conclusion null
- PR #100 exact head `3db9657c3d3507334c8b769c22812b22647269a9`: run `36087940630` / #643 / **in_progress**, conclusion null

Nonterminal runs are not accepted as pass.

## 4. PR #100 content and base

PR #100:
- base branch: `scale/T00/bootstrap-baseline`
- base SHA: `00845b58d5da035bac97978e9dba8dc2235ff338`
- head: `3db9657c3d3507334c8b769c22812b22647269a9`

The current `scale/T00/bootstrap-baseline` branch is exactly `00845b58d5da035bac97978e9dba8dc2235ff338`, so PR #100 is based on the current T00 coordination branch at this observation.

The four changed files are the expected T00-01 rebaseline artifacts:
- `integration/scale/baseline.lock`
- `integration/scale/evidence/T00-01/rebaseline-epoch4.json`
- `integration/scale/evidence/T00-01/remote-observation.json`
- `integration/scale/evidence/T00-01/result-packet.json`

Their epoch-4 baseline values and required blob identities match the remote observations above.

## 5. Evidence inconsistency found

`integration/scale/evidence/T00-01/result-packet.json` still ends with:

> "current file identity is the Git commit/blob identity of the epoch-3 rebaseline branch."

That wording is stale in an epoch-4 packet. The machine baseline values are epoch 4 and correct, but the evidence packet should not describe its current identity as epoch 3. T19 requires this to be corrected before acceptance so the audit record is internally consistent.

## Blocking reasons

1. **BEVAL_EXACT_HEAD_CI_PENDING** — beval run #868 is queued.
2. **PR100_EXACT_HEAD_CI_IN_PROGRESS** — PR #100 exact-head CI #643 is not terminal.
3. **EPOCH4_RESULT_PACKET_STALE_NOTE** — epoch-4 result packet still calls the current identity the epoch-3 rebaseline branch.

Heads, required blobs, and PR base alignment otherwise PASS.

T19 therefore returns **BLOCKED**, not ACCEPTED. Re-review should use the same exact heads only if they remain current when both CI runs become terminal and the stale epoch note is corrected.
