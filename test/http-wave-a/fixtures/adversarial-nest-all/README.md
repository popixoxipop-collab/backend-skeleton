# T12 NestJS `@All` and guard differential

The stored `oracle-output.json` was produced on Bob from actual `@nestjs/core`,
`@nestjs/common` and `@nestjs/platform-express` 12.0.1. The oracle starts a
local disposable app on `127.0.0.1` with an ephemeral port, probes seven methods
with and without a token, then closes it. It is not a deployment or support claim.

From the repository root, after the sibling target-scope fixture is installed:

```sh
cd test/http-wave-a/fixtures/target-scope/nestjs
npm ci --ignore-scripts --no-audit --no-fund
cd ../../../../..
node test/http-wave-a/fixtures/adversarial-nest-all/oracle.mjs
```

The runtime oracle source SHA-256 is
`1ba45bcfa52f19c8a1a278ab876feff2eb21f1a5e446044bcbc46a1c8efdf721`;
the complete Bob stdout SHA-256 is
`1a601e7fc82e561b10c06056ed411d3aee51ba940d4732106007d7ff8e11a041`.
The normal nested T12 test pins the oracle source and stored result, and tests
the real projection plus five source-level mutants. The heavy framework install
and live oracle are opt-in, not part of the ordinary CI lane.

This demonstrates a negative boundary: the leaf emits an explicit `@All` unknown
and guard unknowns; it does not resolve the full method set or authorization
policy. T04 still lacks a real structure-facts producer for this leaf. No Wave A
framework, registry, capability or release certification follows from this run.
