# T07-06 replay receipt

Marker: `DOT-T00-R262-T07-06-20261121`.

## Pins and inventory

- Base/current main candidate: `609c9410919d241186c9d912c8ffc152c8104011`; tree `b7487182a353412bfdba3ed92b4b86ca099294b4`; package lock SHA-256 `c5d31a4bcef1168f6fd07db2544efca0f95d2dad841d108f608a1e23e59e83e0`.
- Previous: `271d5d747d7ef99fb7ce990a95db32fbdf4e46bd`; tree `c5f1da277f3858cc93cefa8b6c3c0d5956b23e07`; package lock SHA-256 `f53dc054a10dafadcb217a17f3805253bdafc123b0943026ee453dee20210087`.
- Previous npm archive: 217 members; SHA-256 `72efda536e010294d35941b70f056e435239ba3853f10243c3ec53e3b3766d5b`; complete installed inventory SHA-256 `23a79f2f67b01f95211de786c10e7e188150537f549820c48f4254709e8fbc4b`.
- Candidate npm archive: 423 members; SHA-256 `2051c8cda0fa2cda077863fce4b3e32be2e8eefc4837c459c1853aad06863c3a`; complete installed inventory SHA-256 `71395c605f3c98a5439e3c9bcae81c9c5a2d2dfeb9cc225695744c5e7064dcab`.
- Node `v24.19.0`; npm CLI SHA-256 `8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7`; Linux; package umask `022`.

The source for each archive member was read by exact Git commit/blob and mode.
The retained manifest contains every expected installed path, byte length,
SHA-256 and mode; the receipts contain observed full-inventory hashes at each
stage. The previous inventory matches after both normal and fault recovery.
The eight installed candidate vectors check literal Rails/Laravel/Symfony
routes, dynamic parent unknowns, missing Symfony methods, explicit
ActiveRecord metadata and implicit Eloquent unknowns.

## Local execution

At `2026-11-20T19:10:30Z`–`2026-11-20T19:10:44Z` UTC:

```sh
T07_REPLAY_OUTPUT_DIR=/workspace/t07-06-evidence-v2 node scripts/run-next-nested-tests.mjs T07
```

Exit `0`; tests `78`, pass `77`, fail `0`, skip `1` (Ruby 2.6 and 4.0
interpreters were not both available). Exact stdout is `test-stdout.tap`,
SHA-256 `3e3e9ddfb4443c86b7a07111afef6f6be8c1909f7cfe9efde165fbefa626c389`.
The normal receipt is `pass`, with zero failures and previous-package
restoration. The injected candidate probe terminates with `SIGTERM`; its
receipt records expected `T07_CANDIDATE_PROBE_SIGTERM`, status `fail`, then
previous-package restoration. Both source and installed byte/mode mutation
controls were rejected; wrong manifest and archive hashes were also rejected.

Evidence files SHA-256:

- `manifest.json`: `71a68fac6761a65aa6658ab79f3e84fafcc25d5c87f05b9db84f0050e35641f0`
- `normal-receipt.json`: `6e48763029df27680035cb3e18245822362391aec1a8e85926f5c44b6c9e8872`
- `fault-receipt.json`: `0e11ea38ba3c372332d91c9d640222d18741afdabfd0ae98eb2cfff539cdf84d`

The two `.tgz` archives were retained outside Git at the output directory
named above. Their hashes are recorded in the manifest. Recreate them from the
exact Git pins using the test; npm archive byte identity may depend on npm
toolchain version. No target Ruby/PHP runtime, npm mid-transaction recovery,
service rollback, or T19 independent approval was demonstrated here.
