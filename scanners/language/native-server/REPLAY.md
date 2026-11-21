# T08 static worker package replay

`DOT-T00-T08-06-20261122` covers a historical Node/static worker slice of
T08-06. The previous commit is `271d5d747d7ef99fb7ce990a95db32fbdf4e46bd`
(before the native-server package); the candidate is
`0ecc6a27d026f8e5efbfdae36637534fd5d08a2d` (the exact main used for
this change). Neither pin follows a moving branch. The replay is a disposable
consumer installation, not a deployment or release promotion.

Run `node --test test/language-native-server/package-replay.test.mjs` from a
checkout containing both Git commits. Set `T08_REPLAY_OUTPUT_DIR` to a new
absolute path to retain the two package archives, manifest, complete installed
file inventories, and normal/fault receipts. Scratch source archives, npm cache,
and disposable consumers are removed when the test exits. The test uses
`npm pack --offline --ignore-scripts` and a pinned npm executable, then checks
every packed and installed file against exact Git bytes and modes. It rejects
tampered source bytes/modes, manifest bytes, and archive bytes. Dependency
versions are pinned from the exact package lock and checked to be the same at
both historical commits.

Each normal run installs previous → candidate → previous. A second run sends
SIGTERM to the candidate's installed probe after it computes the static facts,
then reinstalls previous. Both runs compare the complete final installed
inventory with the initial previous inventory. The installed candidate probe
checks a literal Go/Gin group route and a computed path that must stay unknown.
The previous package has no native-server module; its probe verifies absence.
Receipts include probe exit or signal and stdout/stderr hashes. A failed test
is not a successful restore receipt.

## Limits and remaining review

- The historical candidate is not this PR's head. CI must run at this PR's
  exact head to validate this test and documentation; merge and main CI remain
  distinct evidence.
- The installed fact vectors exercise Go/Gin only. The broader existing T08
  focused suite covers additional static source analyzers but this replay does
  not certify C# or Rust installed behavior, framework runtime behavior, or
  compiler-backed Go/Roslyn/Rust helpers. Those helpers are not packaged here.
- The runner is a first-party Node worker, not an OS sandbox. This test does
  not prove process isolation, network restrictions, or release safety.
- A T19 independent review bundle, cross-platform exact-head evidence, and
  T00/T23 promotion decisions are separate. No scanner registry, CLI, or
  release activation is changed by this replay.
