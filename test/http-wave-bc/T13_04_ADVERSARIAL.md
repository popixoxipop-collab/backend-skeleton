# T13-04 — HTTP Wave B/C adversarial gate

This gate covers the three implemented experimental static-scanner leaves: Hono,
Koa + @koa/router, and Next.js App Router. It does not certify framework runtime
behavior or claim that these leaves are registered in the production scanner.

`t13-product-mutations.json` pins three critical and one noncritical source-code
mutant to adversarial vectors exercised by the leaf suites. The T13 nested CI suite executes
`t13-adversarial.test.mjs` on Node 22 and 24. Its mutation test uses the shared
T19 runner: a clean Git commit is archived, dependencies are installed with
`npm ci --ignore-scripts`, baseline tests must pass, and each mutant must fail
those same tests. Timeouts, signals, failed baselines, and unapplied mutations
are not accepted as kills.

The permission test creates a normally detectable Hono project outside the
checkout, then runs the detector in a child Node process with `--permission`
and read access only to the checkout. It requires an explicit
`ERR_ACCESS_DENIED`, no detected project, and no emitted module. This probes
Node's filesystem permission model, not an operating-system sandbox.

Reproduce on a clean checkout of the reviewed commit:

```sh
node --test test/http-wave-bc/t13-adversarial.test.mjs
node scripts/run-next-nested-tests.mjs T13
```

The GitHub `nested-next` matrix runs T13 under Node 22 and 24. Record the exact
head SHA, both job URLs and exit statuses, and the merged-tree replay in the T00
audit before promoting this row to MET. A green local run alone is insufficient.
