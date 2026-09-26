# T10 Test Execution

The T10 tests live under `test/persistence-next/*.test.mjs`.

Run them directly:

```bash
node --test test/persistence-next/*.test.mjs
```

The repository's current root `npm test` command is `node --test test/*.test.mjs`; Node's shell
glob does not include this nested directory. Therefore a green existing CI job does **not** by
itself prove the nested T10 suite ran.

Earlier EOE verification, before the remote connector disappeared from the session, completed the
then-current T10 suite and the existing DB regression set. Subsequent ActiveRecord/Django/T07/T14
work has been re-read from the GitHub branch and exercised with isolated branch-source checks, but
must still receive a real Node nested-suite run before this draft PR is promoted.

T10 deliberately does not edit the shared root package/CI files. See `CHANGE_REQUESTS.md`.
