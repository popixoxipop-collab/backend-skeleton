# T06-06 historical installed replay — cloud execution record

Marker `DOT-T00-CONTINUE-20261120`. This is candidate evidence, not an official
T00 MET award or release approval. The user reports official T00 r261 as
147/291 MET and T06-06 NOT_MET. The repository T06 RFC separately calls T06-06
an open promotion/rollback-evidence gate. The exact r261 audit artifact was not
independently read: EOE filename search was rejected for insufficient free CPU,
and a guessed r261 path returned file-not-found. No EOE write was attempted.

Base protected main `425a21c38fe4a0804806ba7fe99d063509e6348d`, tree
`36fa4e21d2727c96e5f81131adc3f9890eb28ddf`.

## Pinned replay and normal result

- Previous Git commit `271d5d747d7ef99fb7ce990a95db32fbdf4e46bd`, tree `c5f1da277f3858cc93cefa8b6c3c0d5956b23e07`; prefreeze Python-layer candidate `24fe7e59e96fb98b18c1319e8a81da86e93e43dc`, tree `94d7674c7f87838db40f55cb8d6b92cc3120e15c`. Both package-lock bytes SHA-256 `f53dc054a10dafadcb217a17f3805253bdafc123b0943026ee453dee20210087`.
- Node v24.19.0, npm CLI SHA-256 `8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7`, Python 3.12.14 executable SHA-256 `fa67443527ed9647f760d807e2a38f26340757123e643c4639cf273ed15d5ea7`.
- Each member's bytes and mode matched Git and the complete installed-package inventory matched the manifest. Previous 217 → candidate 363 → previous 217 files. Previous inventory SHA-256 `39592a138c86b2760b60067bf38c3110692f18b585cd1f872faec069048068d8` was restored exactly in normal and fault replays. The candidate produced six installed Python AST/unknown/error vectors.
- Archives SHA-256: previous `72efda536e010294d35941b70f056e435239ba3853f10243c3ec53e3b3766d5b`, candidate `a168a8e58c256b9c312f9781d4d45ad6b9e8134bdb545347e13a0bd43485e26d`. The archives remain in the local evidence directory and are reproducible from the pinned Git commits; they are not checked into Git.
- Manifest SHA-256 `c9071af21ca281f54df409276b9deb2682113d7f27949d90233b948c74d52612`; normal receipt SHA-256 `69cbab95b2c99444f9e483d4af179f3d9dde8ce05ccd606aeb28314b9fd1f763`; fault receipt SHA-256 `f4367a098a50692e133e39c054af6a6113b481506b0db89024b8e970ff3a3d4e`. The deliberate candidate-probe SIGTERM produces an expected failed receipt, followed by a matching restored previous inventory.

## Local tests and uncertainty

- At 2026-11-20T12:28:31Z–12:28:44Z, `npm_config_cache=/tmp/t06-06-focused-cache T06_REPLAY_OUTPUT_DIR=/workspace/t06-06-evidence-v1 node --test <all test/language-python/*.test.mjs except baseline-record.test.mjs>` exited 0: 126 tests, 125 passed, 0 failed, 1 skipped because the optional Python 3.11/3.12 local matrix was unavailable. Exact TAP stdout SHA-256 `91426e7054c05c400189db661e7e4d28958eb933a9aa1a4dc38f2c88cdffe6d2`.
- `npm_config_cache=/tmp/t06-06-full-cache node scripts/run-next-nested-tests.mjs T06` exited 1: 137 tests, 133 passed, 1 failed, 3 skipped; TAP stdout SHA-256 `9fa44a49cff37832724257b1319e60fb294b2065b25afa4e4926f838e07d2cfe`. The sole failure was the immutable T06-01 baseline test replaying its old package-boundary tests in a sanitized subprocess that inherits `HOME=/home/agent` but drops npm cache overrides. npm could not create `/home/agent/.npm/_cacache`. The committed baseline and its runner were not edited. GitHub CI must be checked separately; this local full-suite failure is not a pass.
- The existing T06 RFC keeps the promotion obligation OPEN until separate adjudication. Its registry test forbids any new T06 test file from naming the item ID while OPEN, so the executable test title names the installed Python package replay without the item ID; this record makes the scope explicit.

This does not test interruption during npm's own write transaction or a running
service rollback. Python parsing follows the selected interpreter; a single
Python 3.12 run does not establish cross-version equivalence. No stable scanner
registration, runtime framework authorization, human review or release is
claimed here.
