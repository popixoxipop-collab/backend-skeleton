# T13-04 bounded adversarial tests

The T13 Wave B/C first slice remains a static, experimental Hono, Koa and
Next.js route projection. This slice adds four explicit product-source mutants in
`T13_04_PRODUCT_MUTATIONS.json`, plus normal, input-negative and filesystem
permission tests in `test/http-wave-bc/t13-adversarial.test.mjs`. The three
critical mutants target a Hono dynamic `basePath`, an unmounted Koa router and a Next.js
dynamic `basePath`; one noncritical mutant targets a missing Koa dependency. Each must be killed by its existing leaf test on an exact
Git source commit. A mere JSON catalog-validity pass is not mutation evidence.

Run `node --test test/http-wave-bc/t13-adversarial.test.mjs` and
`node scripts/run-next-nested-tests.mjs T13` on the reviewed head and the
merged tree. The hosted T13 lane runs on Linux Node 22 and 24. Run the
product mutation command against a clean, pinned commit with the existing
`test/conformance-next/product-mutation-runner.mjs --repo-root <checkout>
--catalog next/t13/T13_04_PRODUCT_MUTATIONS.json --source-commit <head>
--out <receipt>` CLI. Record the exit code, mutant status, receipt hash,
exact source commit, and both test-file and catalog hashes; do not infer a
killed mutant from a setup failure, timeout or baseline failure.

The tests assert only that supported static routes are emitted from normal
source, mutated input cannot invent endpoints, and actual unreadable package
or source bytes do not produce routes under a non-root reader. They do not
execute the Hono, Koa or Next.js frameworks, establish runtime equivalence,
T19 acceptance, independent attestation, certification or release readiness.
Cross-version evidence is the hosted Node 22/24 replay of the same pinned
static framework fixtures; this does not prove behavior on other framework
releases. The exact-head T00 ownership check must pass for every changed path;
no exception is inferred from this document. T00-04 remains PARTIAL.
