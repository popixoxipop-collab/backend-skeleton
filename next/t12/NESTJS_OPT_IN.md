# NestJS fact projection (opt-in)

`nestjs-opt-in.mjs` consumes a JSON envelope containing `moduleFacts` and
`structureFacts` in the shapes accepted by the existing T12 NestJS leaf. From a
source checkout, run:

```sh
node next/t12/nestjs-opt-in.mjs --facts /path/to/t04-facts.json > scan-report.json
node next/t12/nestjs-opt-in.mjs --facts /path/to/t04-facts.json \
  --feature-id 001-nest-users \
  --feature-uid 123e4567-e89b-42d3-a456-426614174000 > candidate.json
```

The first form emits `sbf.scan-report/2`. The second invokes the existing
feature-contract builder and emits both `scanReport` and `contract`. The scan
report retains literal method/path candidates and serialized leaf unknowns;
it records no source files read and no operation IDs. It adds explicit unknowns
for the unverified fact producer, global prefixes, and global authorization.
The feature contract stays **blocked** without independently sourced operation
identities. Consumers must inspect the scan report's unknowns alongside the
feature contract; the feature-contract schema has no field for those unknowns.

This entry point does not parse NestJS source or run an app. The repository has
no producer for the required T04 structure facts. It is not registered in the
stable scanner registry, included in the npm package, enabled by default, or
runtime certified. The frozen T12 baseline and leaf profile are unchanged.
