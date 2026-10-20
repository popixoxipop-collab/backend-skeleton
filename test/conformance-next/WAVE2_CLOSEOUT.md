# T19 wave-2 survivor closeout

This is an additive T19-04 test-strengthening candidate, based on main
`184f603523a53223b3373ce5a2d1845be23234d5`. The historical wave-2 catalog and
recorded 18/23 result remain unchanged. It is not a claim of MET, release
approval, complete 79-vector coverage, or independent signed attestation.

## Behavioral coverage

The original five surviving mutations were replayed on the new main: all five
unmodified baselines passed and all five mutated suites also passed. Added
oracles exercise the actual affected public functions: ENOBUFS classification;
reachable Rust scanner name-reuse cycles; self/two-node Express mount cycles;
signed fixture evidence with a mismatched head for all three repository roles;
and rollback evidence without affirmative restoration. Each refusal has a valid
control. Test-only signing keys never become production trust roots. Source
strings are scanned, not compiled or executed as target applications.

`product-mutations-wave2-closeout.json` retains all 23 original mutation IDs,
anchors, severity and invariants. Only the five survivor test lists gain
`wave2-survivor-invariants.test.mjs`. No product safety checks are weakened and no
old evidence is overwritten.

## Continuous replay

Root `test/t19-wave2-closeout.test.mjs` is discovered by the existing
`npm test` command, so both existing Node 22/24 CI lanes run a fresh five-mutant
campaign rather than only checking stored JSON. The existing runner materializes
Git source, installs locked dependencies with scripts disabled and bounds child
process groups. A failed unmodified baseline, timeout, missing mutation anchor
or surviving mutant never satisfies the new gate. The new oracle file is also
discovered by the ordinary T19 nested suite. No workflow is disabled or relaxed.

Run from a clean committed checkout with the dependency cache prewarmed:

```sh
node --test test/conformance-next/wave2-survivor-invariants.test.mjs
node --test test/t19-wave2-closeout.test.mjs
node test/conformance-next/product-mutation-runner.mjs --repo-root . \
  --catalog test/conformance-next/product-mutations-wave2-closeout.json \
  --source-commit "$(git rev-parse HEAD)" --out /absolute/external/report.json
```

## Remaining T19-04 scope

The other uncovered negative vectors and the Node18/20, Linux/Windows and
independent-QA requirements must still be assessed separately. These five
regressions do not by themselves close the full T19-04 task or dependent
framework-certification tasks. Full 23-mutant replay and exact-source receipts
are recorded separately; no current success is inferred from historical logs.
