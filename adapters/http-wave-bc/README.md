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

The current machine-readable profile evidence and explicit blockers are recorded in [`profile-evidence.json`](./profile-evidence.json). T23 re-home / required nested-suite integration is tracked in repository issue #137; T19 independent review was requested on PR #118.

## Test and ownership boundary

T13 owns only `adapters/http-wave-bc/**` and `test/http-wave-bc/**` under the T00-03 r1 ownership policy. Reference fixtures therefore live under `test/http-wave-bc/fixtures/**`.

The repository's current `npm test` glob only discovers `test/*.test.mjs`. T13 does **not** add a root-level aggregation shim because that path is outside its lease. The focused suite is:

```bash
node --test test/http-wave-bc/*.test.mjs
```

Making nested suites part of required root CI is a T00/T23 integration change. Until that integration lands, a green repository-wide CI run does not by itself prove that the latest T13 focused tests executed.

T00-04A is now active on the coordinator integration line and T00-04B classifies T13 as `PROFILE_BY_PROFILE`. The current Hono, Koa, and Next.js slices have exact-head static CI evidence, but promotion is still held for T19 independent review and T23 lease/nested-suite integration. Until one of these profiles completes that review path, the remaining catalog entries stay admission targets rather than new implementation fan-out.

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
