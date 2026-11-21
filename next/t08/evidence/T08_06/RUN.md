# T08-06 historical static package replay

Marker: `DOT-T00-T08-06-20261122`. This is local implementation evidence,
not T19 approval or an official T00 status change.

## Exact pins

- Previous `271d5d747d7ef99fb7ce990a95db32fbdf4e46bd`, tree
  `c5f1da277f3858cc93cefa8b6c3c0d5956b23e07`, lock SHA-256
  `f53dc054a10dafadcb217a17f3805253bdafc123b0943026ee453dee20210087`.
- Candidate/base main `0ecc6a27d026f8e5efbfdae36637534fd5d08a2d`, tree
  `49da0382f0a49a1cca69577a4b33268d0a111f32`, lock SHA-256
  `c5d31a4bcef1168f6fd07db2544efca0f95d2dad841d108f608a1e23e59e83e0`.
- Previous 217 members: archive `72efda536e010294d35941b70f056e435239ba3853f10243c3ec53e3b3766d5b`,
  installed inventory `23a79f2f67b01f95211de786c10e7e188150537f549820c48f4254709e8fbc4b`.
- Candidate 423 members: archive `2051c8cda0fa2cda077863fce4b3e32be2e8eefc4837c459c1853aad06863c3a`,
  installed inventory `71395c605f3c98a5439e3c9bcae81c9c5a2d2dfeb9cc225695744c5e7064dcab`.
- Linux; Node `v24.19.0`; npm `11.9.0`, executable SHA-256
  `8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7`;
  package umask `022`.

## Commands and result

At 2026-11-21 19:13–19:16 UTC in `/workspace/t08-06-replay`:

```sh
node --test test/language-native-server/*.test.mjs
npm_config_cache="$PWD/.t08-npm-cache" node --test test/language-native-server/*.test.mjs
npm_config_cache="$PWD/.t08-npm-cache" T08_REPLAY_OUTPUT_DIR=/workspace/t08-06-evidence-verified-20261122 node scripts/run-next-nested-tests.mjs T08
```

The first command exited 1 because the existing package test's npm invocation
could not create the sandbox's default `/home/agent/.npm/_cacache` (`ENOENT`,
status 254); stdout SHA-256
`254117305cdfe489983abb2292b177f1282a5ed2bd9c357f0d770c90555db0cb`.
The second command exited 0, 61/61 pass, stdout SHA-256
`d9e9b1103e1219a699227560742dba9b1f7edf08785e5c296ebea0fc52497e04`.
The final command is the repository CI's actual T08 test discovery path; it
exited 0, 61/61 pass. Its exact output is `test-stdout.tap`, SHA-256
`c1a09eb0d05e243107978c15443dee30be9a3452547cb5af9fd9b8539a8f7435`.
The temporary npm cache was removed after each successful rerun.

Both normal and SIGTERM candidate probe paths installed the real tarballs into
disposable consumers and restored the entire previous installed inventory.
The installed `index.mjs` exported a `NATIVE_WORKER_PATH` inside the installed
package, and `runNativeServerWorker` spawned that Node child for literal and
unknown Go/Gin facts. Source and installed byte/mode changes, manifest changes,
and archive byte changes were detected by negative controls. The fault receipt
records the expected candidate `SIGTERM` and restored previous inventory.

Evidence SHA-256: `manifest.json`
`7700e59db6f61128d38a9361a1396aaa6ff8ff5516c118e3baeff76ff9ec325d`,
`normal-receipt.json`
`a1d149c2fb15575cf56e721ee1ea2b9968c7808174b7a45c208cc43b3e431ed6`,
`fault-receipt.json`
`f3e246343413f38c49bac4af40f0f0a4d46cca7ca95eb195e330b4eb8fafcc99`.
The full installed inventories are separate JSON files beside the manifest.
The two tarballs are retained outside Git at the output path above and can be
regenerated from the pinned Git commits with the recorded npm executable.
This proves neither mid-install transaction recovery nor compiler helpers,
cross-platform parity, independent T19 approval, or a release decision.
