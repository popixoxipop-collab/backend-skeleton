# T13 — HTTP Wave B/C experimental adapters

This directory is the T13-owned staging area for Wave B/C HTTP framework work.

## Integration boundary

Nothing under this directory is a production-registered scanner merely because the file exists.

Production registration requires the shared project-composition / adapter-SDK interfaces, conformance evidence, and an integration-owner change to the stable registry path. T13 does not modify `scanners/registry.mjs`, `scanners/index.mjs`, stable schemas, package metadata, or existing production adapters in this branch.

All current leaf adapters deliberately keep:

- `api.operations: false`
- `api.request-shape: false`
- `resource.fetch: false`
- `codegen.handles: false`
- `verificationBasis: synthetic-only`

Pinned framework-author-maintained fixtures improve regression quality but do not, by themselves, certify the whole adapter.

## Current leaf status

| Target | Static first slice | Explicitly withheld / unknown |
|---|---|---|
| `node-hono` | literal per-verb routes, literal `basePath()`, bounded same-file / relative-import `route()` graph, source provenance, pure `showRoutes()` output parser | dynamic paths/basePath, `all/on/use/mount`, unresolved imports, schema/security/persistence/codegen, runtime execution |
| `node-koa` | same-file mounted Koa + `@koa/router`, literal standard-method routes, named routes, constructor prefix, ESM/CommonJS/generic Router bindings | unmounted/cross-file router wiring, `prefix()` mutation, `all()/use()/register()/redirect()`, dynamic/array/RegExp paths, host/custom-method semantics, runtime middleware behavior |
| `typescript-nextjs` | App Router `route.js|ts`, explicit method exports, route groups, simple `[param]`, literal `basePath`, local export aliases | catch-all/optional catch-all, intercepting/parallel/private segments, Pages API method control flow, external re-export following, framework-generated OPTIONS |

The remaining Wave B/C entries in `catalog.mjs` are admission targets, not implemented support.

## Frozen upstream references

- Hono: `honojs/hono@3ed3a14f6d47f3a000f6f0206912261fc0e4b6cd`
- @koa/router: `koajs/router@dc285194dfbd9887b7ab9937996370dc4fda55d7`
- Next.js canary: `vercel/next.js@cb95ca373be557309a962d8a6e64a75c6732bc5d`

Each fixture directory carries its own attribution and scope note.

The current machine-readable profile evidence and explicit blockers are recorded in [`profile-evidence.json`](./profile-evidence.json). The nested-suite CI integration that earlier text listed as a blocker is on `main` (see "Test and ownership boundary"). The T19 review packet is [`t19-review-request.json`](./t19-review-request.json), whose status is `REQUESTED_NOT_ACCEPTED`; this README records no review outcome.

## Test and ownership boundary

T13 owns only `adapters/http-wave-bc/**` and `test/http-wave-bc/**` under the T00-03 r1 ownership policy. Reference fixtures therefore live under `test/http-wave-bc/fixtures/**`.

The repository's current `npm test` glob only discovers `test/*.test.mjs`. T13 does **not** add a root-level aggregation shim because that path is outside its lease. The focused suite is:

```bash
node --test test/http-wave-bc/*.test.mjs
```

Making nested suites part of required CI was a T00/T23 integration change, and it is on `main`: the nested-next job runs this suite as the `T13 http-wave-bc` step (`.github/workflows/ci.yml:150-151`, `node scripts/run-next-nested-tests.mjs T13`). Root `npm test` still does not discover it, so a green root `npm test` alone does not prove the T13 tests ran; the nested-next job does. GitHub branch protection on `main` of this repository lists `nested-next (22.x)` and `nested-next (24.x)` among its required status checks (read from the GitHub API on 2026-10-03; that setting lives in GitHub, not in this repository, so re-check it before relying on it).

T00-04A is now active on the coordinator integration line and T00-04B classifies T13 as `PROFILE_BY_PROFILE`. The current Hono, Koa, and Next.js slices have exact-head static CI evidence, but promotion is still held for T19 independent review. The nested-suite CI integration is on `main` (see above). `profile-evidence.json` (`promotion_blockers`, `promotion_state` `HOLD_T19_T23`) keeps the T19 review, the package-allowlist decision for `adapters/http-wave-bc/**`, the registry integration and the runtime evidence as open; this README does not evaluate them. Until one of these profiles completes that review path, the remaining catalog entries stay admission targets rather than new implementation fan-out.

## Baseline record and interface RFC

[`BASELINE.json`](./BASELINE.json) pins this directory, `test/http-wave-bc` and the files they import at commit `15a38e923cb5e079c6f8e2a4c2a9386406c41f52`. `test/http-wave-bc/baseline-record.test.mjs` derives again the figures that `verification.recomputed` lists; `verification.not_recomputed` lists what stays unchecked. Of this README it compares four things with the record: the table rows below, each figure written as `<n> tests` or `<n> test files`, the `NESTED_SUITE` line and the mention of the base commit; the other sentences are not compared. [`INTERFACE_RFC.md`](./INTERFACE_RFC.md) states the input, output and identity rules of the three leaves (its sections 3 to 5), and `test/http-wave-bc/interface-rfc.test.mjs` compares its title, headings, tables, key lists, schema names, code spans and line count with `test/http-wave-bc/interface-rfc.vocabulary.json` and with the code, and runs one named check per claim row; the header of the RFC says which sentences are not compared.

At that commit `node --test` over the 7 test files and `node scripts/run-next-nested-tests.mjs T13` each exited 0 with 66 tests. The runner printed `NESTED_SUITE T13 RUN 7 files` there; later commits add test files, so that line and the table below describe the base commit, not the working tree.

| Test file | Tests at the base commit |
|---|---|
| `catalog.test.mjs` | 9 |
| `hono-show-routes.test.mjs` | 3 |
| `leaf-inventory.test.mjs` | 3 |
| `node-hono.test.mjs` | 19 |
| `node-koa.test.mjs` | 12 |
| `profile-evidence.test.mjs` | 4 |
| `typescript-nextjs.test.mjs` | 16 |

`catalog.test.mjs` imports `leaf-inventory.test.mjs` and `profile-evidence.test.mjs`, so its 9 are its own 2 plus their 3 and 4, and the total counts those two files twice.

The record describes observed behaviour. It supports no framework, runs no framework runtime and no fixture oracle, and keeps the catalog targets without a leaf as NOT_RECORDED / UNSUPPORTED (their number is in `BASELINE.json`). Its `limits` list what stays open.

## Promotion rule

A leaf may move toward production registration only when its claimed capability subset has:

1. current adapter-schema conformance,
2. deterministic read-set behavior,
3. negative fixtures for dynamic/ambiguous forms,
4. pinned reference or real-repo coverage appropriate to the claim,
5. isolated runtime evidence when the claim depends on framework execution,
6. no guessing across unsupported semantics,
7. integration-owner approval for the shared registry / project-composition layer.

A target can remain Discovery/Contract-only. Lack of runtime evidence must not be converted into a stronger support label.

## T13-02 interface evidence receipt

The source-bound receipt at `test/http-wave-bc/interface-rfc-evidence.json` pins the exact
reviewed commit and SHA-256 of the RFC, vocabulary and executable interface test.
It records a real zero-skip test command, exit code and counts. Reproduce its result with
`node test/http-wave-bc/interface-rfc-evidence.mjs --check`; this reruns the pinned
interface test and rejects changes to any pinned file or a forged MET/release claim.
The historical T13-01 baseline stays unchanged; the current nested T13 CI suite
provides separate full-track results. An independent reviewer and authorized T00
CAS audit remain required before any official MET change.
