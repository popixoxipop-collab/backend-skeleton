# T06-06 historical installed-package replay

The T06 RFC records T06-06 as the open promotion/rollback-evidence gate. This
candidate uses exact Git package commits `271d5d747d7ef99fb7ce990a95db32fbdf4e46bd`
(previous) and `24fe7e59e96fb98b18c1319e8a81da86e93e43dc` (Python-layer
candidate before the T06 baseline freeze). The test compares every npm member
against its Git bytes and file mode, then the complete installed
`backend-skeleton` package inventory in a disposable consumer. The previous
package has no T06 Python modules.

The candidate probe imports the **installed** `analyzer.mjs`, which launches its
installed `ast-helper.py` with a pinned external Python interpreter. Six vectors
check decorator/annotation AST facts, dynamic-expression unknowns, structured
syntax failure, non-execution of target top-level statements, explicit missing
interpreter, and source-byte limit. No target package import or target statement
is executed. The probe reports interpreter version and executable SHA-256.

Normal previous → candidate → previous installation restores the first complete
package inventory. In a separate replay, SIGTERM interrupts the **candidate
probe**, after which the surviving parent restores the previous package.
`T06_REPLAY_OUTPUT_DIR` may name a fresh absolute path to retain the two
archives, complete manifest/inventories and normal/fault receipts. Existing
paths are rejected to avoid overwriting evidence.

This is historical installed-package evidence. It does not interrupt npm's own
write transaction, roll back a running service, approve external dependencies,
validate runtime framework behavior, or prove stable scanner registration.
Python AST support follows the selected interpreter; unsupported/dynamic
expressions remain unknown. A Codex review is not a human approval. Independent
T00 adjudication and release gates remain separate; this test does not modify
the official ledger or itself establish MET.
