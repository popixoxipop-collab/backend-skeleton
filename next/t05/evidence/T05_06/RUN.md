# T05-06 historical installed replay — local execution record

Marker: `DOT-T00-5FC4E9A4`. This is candidate evidence, not a T00 MET
award or release approval. Base main `530538583f278d64670af5dcd79956f649416528`,
tree `e2ad377e8d55ba22b64ff13629753e3938e8072b`.

- UTC execution: 2026-11-20T06:21:21Z to 2026-11-20T06:21:32Z.
- Command: `T05_REPLAY_OUTPUT_DIR=/workspace/t05-06-replay-evidence-final node --test test/language-jvm/*.test.mjs test/java-spring-analyzer.test.mjs`.
- Exit 0; Node v24.19.0, npm 11.9.0, Linux. npm CLI executable SHA-256 `8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7`.
- TAP stdout SHA-256 `0cf6ded5eeb7d035215ab2fa194a9d54dd0c56c2513e1dd7b59e7f788dcecea1`: 97 tests, 96 pass, 0 fail, 1 existing live-baseline skip because the candidate adds T05 files. The pinned-baseline replay still ran.
- `manifest.json` SHA-256 `cba249024466883a7d03b1f74ff61bd85b600e5c4731155e6bd9351ed4f43d29`; it includes every package member's Git-backed expected installed byte hash and mode.
- `normal-receipt.json` SHA-256 `2f7394c7a1f2d45e1d7dee5d5bcd3ad4b8a02ca3be39bea983f0b6b4ba3cdb4d`: previous 217 → candidate 363 → previous 217 package files; six installed Java candidate vectors; restored prior inventory SHA-256 `39592a138c86b2760b60067bf38c3110692f18b585cd1f872faec069048068d8`.
- `fault-receipt.json` SHA-256 `e085072d0de19c6b643d0b8f731f0a2b97404fb620a600710a9631e6f74de3f6`: expected candidate probe SIGTERM, failed candidate stage, then successful previous inventory restoration. The receipt's `status: fail` describes the deliberate fault; the test itself passed.
- Prior Git commit `271d5d747d7ef99fb7ce990a95db32fbdf4e46bd`, tree `c5f1da277f3858cc93cefa8b6c3c0d5956b23e07`; candidate prefreeze commit `24fe7e59e96fb98b18c1319e8a81da86e93e43dc`, tree `94d7674c7f87838db40f55cb8d6b92cc3120e15c`. Both lockfiles SHA-256 `f53dc054a10dafadcb217a17f3805253bdafc123b0943026ee453dee20210087`.
- Archived package SHA-256: previous `72efda536e010294d35941b70f056e435239ba3853f10243c3ec53e3b3766d5b`; candidate `a168a8e58c256b9c312f9781d4d45ad6b9e8134bdb545347e13a0bd43485e26d`. The archives are retained in the local evidence directory and can be reproduced from the pinned Git commits; they are not checked into Git.

The tests verify every npm package member's byte hash and mode against Git,
then compare the complete installed `backend-skeleton` package inventory. The
candidate probe imports the installed JVM modules. It does not compile Java,
execute target code, validate a complete classpath or perform a real service
rollback. Independent review and exact-head CI are separate gates.
