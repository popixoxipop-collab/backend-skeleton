# T19 independent before/after review — issue #119 vs T11

**Verdict: BLOCKED(T11_DOES_NOT_FIX_119)**

Reviewed: 2026-09-26

## Independent fixed input

Holdout repository:
- `syedammar/rest-api-nodejs-typescript`
- commit: `798546fc0e89365ac601be15c857c589916205d4`
- license: MIT

Independent T19 expected adapter:
- `typescript-express`

Independent expected source shape remains:

```ts
import express, { Router } from 'express';
const userRouter: Router = express.Router();
userRouter.get('/:id', authentication, getUserById);
```

The expected result was not regenerated from either candidate.

## Compared code

Baseline:
- bskel main checkout used by T19: current main lineage
- scanner behavior: existing shipped TypeScript Express detector

T11:
- PR #77
- head: `5d328f906dd81fde508c1cd652a6ab159e22a29e`
- changed paths remain under `adapters/http-legacy-next/**` and `test/http-legacy-next/**`
- T11 does not modify `scanners/adapters/typescript-express.mjs` or its shared detector implementation

## Environment preparation

The first execution attempt in both checkouts failed before scanner execution because `pg` was not installed.

Both checkouts then received the same:

```bash
npm ci --silent
```

Both installs exited 0.

This initial dependency-preparation failure is not counted as product behavior evidence.

## Same-input execution

Baseline command:

```bash
node t19-review-main119/scripts/shadow-validation-smoke.mjs \
  --manifest t19-private-oracle-manifest.json \
  --adapter typescript-express \
  --out t19-119-main.json
```

Observed:
- exit 1 from smoke wrapper;
- selected scanner: `generic-grep`;
- feature scan blocked with exit 16;
- low-confidence refusal remained active.

T11 command:

```bash
node t19-review-t11/scripts/shadow-validation-smoke.mjs \
  --manifest t19-private-oracle-manifest.json \
  --adapter typescript-express \
  --out t19-119-t11.json
```

Observed:
- exit 1 from smoke wrapper;
- selected scanner: `generic-grep`;
- feature scan blocked with exit 16;
- low-confidence refusal remained active.

## Differential

```text
expected adapter: typescript-express

baseline actual: generic-grep / blocked exit 16
T11 actual:     generic-grep / blocked exit 16

detector recovery: NO
safety regression: NO
issue #119 fixed: NO
```

T11 preserves the safe low-confidence behavior but does not change the detector defect.

The previous T19 independent gold remains authoritative:
- leaf declaration precision: 1.0
- leaf declaration recall: 6/7
- absolute API-surface precision: 0
- absolute API-surface recall: 0

Those metrics are not recomputed from T11 output because there is no detector recovery or changed observed surface.

## Decision

```text
BLOCKED(T11_DOES_NOT_FIX_119)
```

This is **not** a failure of T11's stated shadow/parity scope. It means only that PR #77 cannot be used as evidence that issue #119 is fixed.

Issue #119 remains open until a T11/adapter-owner fix head satisfies the existing T19 acceptance gate:

1. exact pinned holdout;
2. `typescript-express` selected;
3. generic low-confidence guard remains fail-closed on unrelated repos;
4. existing TypeScript/shared Express regressions remain green;
5. T19 reruns the exact holdout;
6. T19 records the before/after route/mount differential.

No product file was modified by T19.
