# T19 -> T00/T23 shared-owner change request: required CI integration

Date: 2026-09-25
Requester: T19 independent QA
Status: OPEN
T19 branch: `scale/t19-qa-corpus-foundation`

## Problem

The repository currently defines:

```
npm test -> node --test test/*.test.mjs
```

T19 owns its tests under `test/conformance-next/**` and `test/corpus-next/**`. The required nested test is:

```
test/conformance-next/t19-foundation.test.mjs
```

It is therefore not discovered by the current `npm test` glob.

## Requested integration

T00/T23 should add one required CI path that executes the T19 nested suite against the exact PR head. Acceptable shapes include a dedicated package script or a dedicated workflow step/job, for example conceptually:

```
node --test test/conformance-next/*.test.mjs
```

The exact integration mechanism belongs to T00/T23 because `package.json` and `.github/workflows/**` are shared-owner files.

## Required semantics

1. Runs on the exact PR/head commit, not an older green run.
2. Missing nested test files or a skipped/queued/nonterminal job are not PASS.
3. The job must be required for changes touching T19 QA code or a shared contract that T19 consumes.
4. Existing `npm test` remains required; the nested lane supplements it.
5. Failure output must identify the exact head SHA and command.
6. No network corpus cloning is required for this lane; T19 foundation tests are deterministic/offline.
7. A green ordinary CI job that did not execute the nested suite must not be used as T19 evidence.

## Acceptance evidence requested back from T00/T23

- exact integration commit SHA
- changed shared files
- package/workflow blob SHA
- exact-head CI run ID + run number
- terminal success conclusion
- job ID/name
- log/step evidence showing the nested T19 command actually ran
- rollback path

T19 will independently verify those artifacts before treating the CI gap as closed.
