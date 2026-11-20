# T07-06 historical installed-package replay

Evidence marker: `DOT-T00-R262-T07-06-20261121`.

This replay pins the previous package to Git commit
`271d5d747d7ef99fb7ce990a95db32fbdf4e46bd` and the candidate to the
then-current `main` commit `609c9410919d241186c9d912c8ffc152c8104011`.
The previous package has none of the ten T07 Ruby/PHP modules. The candidate
includes them. Every packed npm member is compared with that commit's Git blob
bytes and mode. The complete installed `backend-skeleton` file inventory is
then compared with those expected bytes and installed modes in a disposable
consumer. The test rejects changed source bytes/mode, changed installed
bytes/mode, a wrong manifest hash, and a changed archive hash.

The candidate probe imports **installed** T07 modules and checks eight bounded
Rails, Laravel, Symfony, ActiveRecord, and Eloquent static DSL fact/unknown
vectors. It does not start a Ruby or PHP application. A normal run installs
previous → candidate → previous. A separate run sends SIGTERM to the candidate
probe, then the surviving parent reinstalls and verifies the previous package.
The intentionally failed probe is recorded as `status: fail` in the fault
receipt; the recovery is asserted independently.

Run `node scripts/run-next-nested-tests.mjs T07`. Set
`T07_REPLAY_OUTPUT_DIR` to a fresh absolute directory to retain both archives,
the full inventory manifest, and normal/fault receipts. The directory must not
exist before the run. The checked-in evidence and the exact local command are
in [`evidence/T07_06/RUN.md`](evidence/T07_06/RUN.md).

This is a historical **installed package** replay. The interruption occurs
after installation in the candidate probe, not inside npm's transaction. It
does not restore a running service or prove deployment rollback. The source
probe does not establish Rails/Laravel/Symfony runtime route equivalence,
adapter registration, production readiness, or a release decision. Dynamic DSL
expressions, implicit model conventions, and Symfony routes without an
explicit finite method set remain unknown. T07-05 runtime evidence and T19
independent review are separate gates. A passing replay does not change the
official T00 ledger or itself establish MET.
