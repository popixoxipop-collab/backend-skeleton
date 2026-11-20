# T04-06 historical installed-package replay

`test/language-js-ts/package-replay.test.mjs` packages two exact Git revisions,
verifies every npm member against its Git source bytes and mode, installs the
packages in a disposable consumer, and compares complete installed inventories.
The previous package has no T04 lexical facts modules; the candidate has them
and runs literal, inert-text, nonliteral-dynamic, and byte-limit vectors from
the installed package. Previous → candidate → previous installation restores
the first inventory byte-for-byte. A separate candidate-probe SIGTERM yields
an expected failed receipt, after which the surviving parent restores the
previous package. Manifests and receipts can be retained with
`T04_REPLAY_OUTPUT_DIR` on a trusted evidence volume.

This is candidate-prefreeze, historical package evidence only. It is not a
parser dependency approval, a proof of syntax or semantic validation, a test
of interruption during npm's own write transaction, a running-service
rollback, a signed independent attestation, or an authorization to ship T04
as a stable parser. `syntaxValidated` remains false. T20/T23 approval for a
future parser and the global T00 release gate remain separate.
