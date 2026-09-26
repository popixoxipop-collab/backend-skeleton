# T19 independent review — T01 two-consumer aggregation

**Verdict: PASS for T01-05 consumer compatibility only**

Reviewed: 2026-09-26

## Upstream T01 candidate

- PR #82
- head: `e499073aaa7fe9c116e30fbff0536cccecb6eb69`
- base: `5472a8b82655840d1d3ce76cb926987376e37ca6`
- status: open / draft
- exact-head CI: `36094807573` — success

Reviewed conformance pack:
- path: `schemas/next/identity-conformance.json`
- Git blob: `519ae080631cebeed9f3426365ce661f361d90b3`
- byte SHA-256: `2df0d860428cb8b6bcc1bcdb560f06ccd1257b3937af65448011a1f0d0c1ec42`
- cases: 12

Required consumer repositories defined by T01:
- `popixoxipop-collab/backend-decoder`
- `popixoxipop-collab/Backend-evaluation`

## Consumer 1 — becoder / T15

PR #10:
- head: `9697098f45893d4647060cce02694655864e3300`
- CI #88 / `36102300225` — success

T19 independently cloned exact T15 and T01 branches on EOE and executed:

```bash
node t19-review-becoder-t01/scripts/t01-next-identity-compatibility-smoke.mjs \
  --bskel-root t19-review-bskel-t01 \
  --consumer-commit 9697098f45893d4647060cce02694655864e3300 \
  --out t19-becoder-consumer-result.json
```

Observed:
- exit 0
- consumer repo exact
- commit exact
- pack SHA exact
- `bskel_runtime_imported:false`
- `bskel_runtime_spawned:false`
- 12 passed / 0 failed / 0 not-run
- exact operation ID preserved; no repair

Result artifact:
- `t19-becoder-consumer-result.json`
- SHA-256 `49cc3052bb1e028e46a23859dd3c4341d47225b2d7c24a82baebdc04f6a4e168`
- size 6095 bytes

## Consumer 2 — beval / T16 under T23 required lane

T16 owned reader originates from PR #52. The required shared integration lane is T23 PR #58:
- exact head: `364df37ece2e7b01361556ea09cd2f8cd7ebc246`
- CI run `36150923266`, attempt 2 — success

Required `next-runtime` jobs:
- Node 20: `108302329078` — success
- Node 22: `108302343853` — success
- Node 24: `108302345903` — success

All three logs bind:
`BEVAL_T16_CONSUMER_COMMIT=364df37ece2e7b01361556ea09cd2f8cd7ebc246`

and emit an actual `T16_IDENTITY_CONSUMER_RESULT`.

T19 extracted the Node 22 result:
- repo: `popixoxipop-collab/Backend-evaluation`
- exact commit: `364df37ece2e7b01361556ea09cd2f8cd7ebc246`
- pack SHA exact
- `bskel_runtime_imported:false`
- `bskel_runtime_spawned:false`
- 12 passed / 0 failed / 0 not-run
- exact operation ID preserved; no repair

Result artifact:
- `t19-beval-consumer-result.json`
- SHA-256 `1dbc4a23c4557988110eb982522183e7fdd8b37a4b374044e867defdb83fd1d5`
- size 5957 bytes

## Independent aggregation

T19 used T01's own exact verifier implementation:
`contracts/next/consumer-conformance.mjs`

and called `verifyRequiredConsumerSet()` with the two independently produced results and the required repository set.

Observed aggregate:
- contract: `sbf.identity-consumer-set/1`
- pack SHA: `2df0d860428cb8b6bcc1bcdb560f06ccd1257b3937af65448011a1f0d0c1ec42`
- required repositories: exactly 2
- Backend-evaluation: 12 verified cases
- backend-decoder: 12 verified cases
- missing consumers: 0
- duplicate consumers: 0
- unexpected consumers: 0

Aggregate artifact:
- `t19-t01-consumer-set.json`
- SHA-256 `6fe521b137cbcffb8054fd61ea195d363f9d97734fb419a31c4ac3ab8332a32d`
- size 825 bytes

## T19 decision

```text
PASS(T01-05_CONSUMER_COMPATIBILITY)
```

T19 independently verifies that both required consumers read/replay the exact reviewed T01 bytes and satisfy the T01 consumer-result contract.

This approval is limited to:
- exact-byte identity compatibility;
- the reviewed 12-case conformance pack;
- the exact consumer SHAs named above.

It does **not** certify:
- T01-06 stable promotion;
- stable CLI/writer cutover;
- runtime behavior correctness;
- Runtime-tested capability;
- merge/release.

Those require their own T00/T23/runtime/promotion gates.

No T01/T15/T16 product files were modified by T19.
