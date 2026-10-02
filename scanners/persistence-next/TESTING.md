# T10 Test Execution

The T10 tests live under `test/persistence-next/*.test.mjs`.

Run them directly:

```bash
node --test test/persistence-next/*.test.mjs
```

The repository's root `npm test` command is `node --test test/*.test.mjs`; Node's shell
glob does not include this nested directory, so a green root `npm test` does **not** by itself prove
the nested T10 suite ran. On `main` the nested-next CI job runs it as the `T10 persistence-next`
step (`.github/workflows/ci.yml:144-145`), which is `node scripts/run-next-nested-tests.mjs T10`.

Historical note from the draft PR #84 era (superseded): earlier EOE verification, before the remote
connector disappeared from the session, completed the then-current T10 suite and the existing DB
regression set. Later ActiveRecord/Django/T07/T14 work was re-read from the GitHub branch and
exercised with isolated branch-source checks, and was still waiting for a real Node nested-suite run
before that draft was promoted. The suite now reaches CI through PR #147 and the nested-next job.

T10 deliberately does not edit the shared root package/CI files. See `CHANGE_REQUESTS.md`.
