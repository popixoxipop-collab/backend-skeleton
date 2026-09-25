# T00-03 Ownership and collision map

Generated: 2026-09-25
Status: **ownership freeze draft; shared interfaces are not yet T00-04-frozen**

## Core rule

Every semantic concept gets one canonical owner. Other tracks consume it; they do not invent parallel identities, parsers, capability vocabularies, release policy, or runtime evidence semantics.

## Canonical ownership

| Concept | Canonical owner |
|---|---|
| Project/service/facet graph | **T02** |
| JS/TS language facts | **T04** |
| JVM language facts | **T05** |
| Python language facts | **T06** |
| Ruby/PHP DSL facts | **T07** |
| Go/Rust/C# language backends | **T08** |
| Exact artifact/action/field identity | **T01** |
| Capability state/certification | **T03** |
| Reconciliation/provenance promotion | **T09** |
| Persistence IR | **T10** |
| Existing HTTP compatibility | **T11** |
| HTTP Wave A | **T12** |
| HTTP Wave B/C | **T13** |
| Codegen/provider composition | **T14** |
| becoder consumer/renderers | **T15** |
| Runtime binding envelope | **T16** |
| Game semantics | **T17** |
| Non-HTTP protocols | **T18** |
| Independent QA/certification | **T19** |
| Trust/security/permissions | **T20** |
| Incremental freshness/cache DAG | **T21** |
| Adapter SDK / diagnostics UX | **T22** |
| Package/release/migrations | **T23** |
| Shared integration/hot-file lease | **T00** |

## Legacy Track A #63 decomposition

- project discovery / source-role ideas → **T02**
- JavaScript/Svelte parser edge cases → **T04** differential corpus
- Three.js runtime/assets/worker facts → **T17**
- game network endpoint inventory → **T17**; protocol/message semantics → **T18**
- generic API-plane findings → **T11/T12/T13**, not a second HTTP authority
- fixtures/reports → **T19** after provenance review

`scanners/multiplane.mjs` and its project/schema stack must not land as a competing global IR before T00-04.

## Legacy Track C #62 decomposition

- fingerprint / stale-current mechanics → **T21**
- receipts/evidence validation → **T19**, freshness inputs → **T21**
- performance profile/evaluation → **T19**
- release policy / gate-profile/default wiring → **T23**
- security/trust assertions → **T20** review

`lib/gate-profiles.mjs` is a shared hot-file change and may not land directly.

## Cross-repo game boundary

1. T17 owns bskel game semantics.
2. T15 owns deterministic becoder renderers/harnesses.
3. merged beval #39 owns Browser Oracle runtime observation.
4. T16 owns immutable runtime binding/evidence references.
5. beval #40 may own repair-only behavior after rebase onto current main.

No layer may fill information that the upstream contract left unknown.

## Shared hot files

Until T00 grants an integration lease, tracks must not edit:
- `bin/bskel.mjs`, `lib/cli.mjs`
- `scanners/index.mjs`, `scanners/registry.mjs`
- stable adapter/capability/contract schemas
- `package.json`, `package-lock.json`
- `.github/workflows/**`
- canonical cross-tool serialization

## Immediate consequences

1. T12 #66 must leave the auto-loaded stable adapter namespace until production registration gates exist.
2. T15 #8 must split renderer work from shared package/product changes.
3. T16 #41 must rebase on current beval main after Browser Oracle merge.
4. T02/T04/T17 each absorb only their assigned pieces from Legacy A #63.
5. T19/T21/T23/T20 divide Legacy C #62; nobody cherry-picks it wholesale.
6. T00-04 waits for T09 correctness and T12/T13 exact-head regressions to be green.
