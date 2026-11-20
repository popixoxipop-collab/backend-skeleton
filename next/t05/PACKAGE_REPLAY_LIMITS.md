# T05-06 historical installed-package replay

`test/language-jvm/package-replay.test.mjs` replays exact Git package commits
`271d5d747d7ef99fb7ce990a95db32fbdf4e46bd` (previous) and
`24fe7e59e96fb98b18c1319e8a81da86e93e43dc` (candidate before the
T05 baseline freeze). It verifies every npm package member against Git bytes
and file mode, then verifies the complete installed `backend-skeleton` package
inventory in a disposable consumer. The previous package has no T05 JVM
modules. The candidate runs six Java fact/unknown vectors from its installed
modules: raw interface annotation without route semantics; direct JPA key
without inherited-key inference; unresolved wildcard JPA import; unsupported
multi-declarator field; framework facts-ready without semantic/runtime approval
and blocked Kotlin; request validation refusing semantic mode without a
classpath pin and refusing target execution.

Normal previous → candidate → previous installation restores the first
inventory byte-for-byte. A second replay sends SIGTERM during the candidate
**probe** and restores the previous package in the surviving parent. Set
`T05_REPLAY_OUTPUT_DIR` to a fresh absolute path on a trusted evidence volume to
retain package archives, full inventories, manifest and both receipts. An
existing path is rejected to prevent overwriting earlier evidence.

This proves a historical, installed, source-only package replay. It does not
exercise interruption during npm's write transaction or rollback of a running
service. It does not prove a Java compiler parse, complete classpath, inherited
JPA semantics, target runtime behavior, helper authorization, Kotlin support,
independent attestation or release approval. The T05 production adapter is
not registered. T16/T20 helper approval, T19 review and T00 release/adjudication
remain separate; this replay does not change the official T00 ledger.
