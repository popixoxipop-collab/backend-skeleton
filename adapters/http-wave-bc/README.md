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
| `node-koa` | `@koa/router` literal standard-method routes, named routes, constructor prefix, ESM/CommonJS/generic Router bindings | `prefix()` mutation, `all()`, `use()` nested routers, RegExp paths, host/custom-method semantics, runtime middleware behavior |
| `typescript-nextjs` | App Router `route.js|ts`, explicit method exports, route groups, simple `[param]`, literal `basePath`, local export aliases | catch-all/optional catch-all, intercepting/parallel/private segments, Pages API method control flow, external re-export following, framework-generated OPTIONS |

The remaining Wave B/C entries in `catalog.mjs` are admission targets, not implemented support.

## Frozen upstream references

- Hono: `honojs/hono@3ed3a14f6d47f3a000f6f0206912261fc0e4b6cd`
- @koa/router: `koajs/router@dc285194dfbd9887b7ab9937996370dc4fda55d7`
- Next.js canary: `vercel/next.js@cb95ca373be557309a962d8a6e64a75c6732bc5d`

Each fixture directory carries its own attribution and scope note.

## Test entry point

The repository's existing test command only picks up `test/*.test.mjs`. T13 leaf tests stay nested under `test/http-wave-bc/` and are imported by `test/http-wave-bc.test.mjs` so the normal Node 22/24 CI lanes execute them without changing `package.json`.

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
