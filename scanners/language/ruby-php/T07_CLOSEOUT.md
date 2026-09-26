# T07 Ruby/PHP DSL analysis closeout

Status at commit `e826b27f26935477e1d7c86afd1a054dd48aa3b8`.

This document is a **track-scoped evidence summary**, not a claim that Rails, Laravel, or Symfony are fully registered production adapters. The existing stable Rails adapter, registry, capability schema, package metadata, and lockfile are unchanged by this branch.

## Implemented contracts

| Contract | Purpose |
|---|---|
| `sbf.dsl-facts/1` | Source-bound Rails/Laravel/Symfony DSL facts with `literal / partial / unknown` states |
| `sbf.dsl-route-candidates/1` | Bounded literal route expansion without synthesizing API operation IDs |
| `sbf.model-facts/1` | Explicit ActiveRecord/Eloquent table, key and relation facts |
| `sbf.dsl-runtime-routes/1` | Parser for already-approved Rails/Laravel/Symfony route-export bytes |
| `sbf.dsl-conformance/1` | Static/runtime route-set comparison without silently reconciling differences |
| `sbf.t07-ruby-php-corpus/1` | Exact-SHA real-repository corpus manifest |
| `sbf.t07-ruby-php-corpus-observation/1` | Static real-repository observation snapshot |

## Safety and semantic boundaries

- Static scanning does not boot Rails, Laravel or Symfony applications.
- Runtime route support only parses bytes exported by an external approved execution boundary.
- Runtime-only routes are not copied back into static facts.
- No T07 fact or route candidate claims an API `operationId`.
- Rails runtime conditions, unsupported dynamic blocks and unresolved naming rules remain explicit unknowns.
- ActiveRecord/Eloquent implicit table and primary-key conventions are not silently inferred.
- Polymorphic relation targets are not guessed.
- Symfony PHP attributes are supported by this slice; YAML/XML/PHP config routing is not.
- Sylius is intentionally observed as zero attribute routes rather than being falsely classified as covered.

## Exact branch verification

On EOE, the exact PR head was fetched and checked out detached:

```
e826b27f26935477e1d7c86afd1a054dd48aa3b8
```

Focused T07 suite:

```
tests 60
pass  60
fail  0
skip  0
```

Repository GitHub Actions CI for this exact head:

```
workflow: CI
status: completed
conclusion: success
```

## Pinned real-repository static corpus

All entries are exact 40-hex Git SHAs. The corpus runner performs an exact-SHA blobless sparse checkout and reads only the configured route/model roots. It does not execute target application code.

| Corpus | Route facts | Literal | Partial | Unknown | Candidates | Expansion unknowns | Models |
|---|---:|---:|---:|---:|---:|---:|---:|
| discourse/discourse | 993 | 717 | 70 | 206 | 873 | 177 dynamic | 227 |
| forem/forem | 587 | 446 | 118 | 23 | 878 | 10 dynamic | 120 |
| mastodon/mastodon | 530 | 396 | 123 | 11 | 759 | 3 unresolved | 111 |
| laravel/laravel | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| koel/koel | 149 | 148 | 0 | 1 | 170 | 9 | 21 |
| monicahq/monica | 350 | 349 | 0 | 1 | 333 | 1 | 64 |
| symfony/demo | 18 | 18 | 0 | 0 | 18 | 1 partial-method | 0 |
| wallabag/wallabag | 123 | 123 | 0 | 0 | 149 | 0 | 0 |
| Sylius/Sylius | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Aggregate observation:

- repositories: 9
- route facts: 2,751
- literal route facts: 2,198
- partial route facts: 311
- unknown route facts: 242
- bounded route candidates: 3,181
- route expansion unknowns: 201
- models: 543
- explicit tables: 53
- explicit primary keys: 0
- model unknowns: 1,080

The high model-unknown count is expected for this conservative slice because implicit ActiveRecord/Eloquent table/primary-key conventions are deliberately not resolved statically.

## Real-corpus defects found and fixed

The pinned corpus found implementation defects that synthetic fixtures had not exposed:

1. Symfony stacked attributes were attached to the wrong target when another attribute such as `IsGranted` appeared between `Route` and the method.
2. Symfony inline comments after attributes prevented target binding.
3. Laravel empty-string route URIs were incorrectly classified as dynamic instead of group-root literals.
4. Rails `scope path: nil` and constraints-only scopes incorrectly contaminated descendants as dynamic.
5. Parenthesized Rails scope literals were not recognized.
6. Rails colon parameters were not normalized for static/runtime comparison.
7. Rails empty-string route URIs were incorrectly classified as dynamic.
8. Nested Rails resources, member/collection blocks, `on:` modes and no-`on` documented custom routes were under-expanded.
9. Rails postfix `if/unless` routes were not explicitly marked runtime-dependent.
10. Rails resources inside collection mode were not resolved.
11. Rails custom `param:` nested-key naming did not match Rails.
12. Rails concern definitions/use sites were not represented separately.

Each fixed pattern now has a focused regression test.

## Remaining known limitations

### Rails
- Dynamic Ruby control flow remains unknown.
- Some irregular resource names require ActiveSupport inflection or runtime evidence. Example: `terms_of_service` nested routes in Mastodon.
- Nested concern use inside concern definitions is not recursively expanded in this bounded pass.
- `draw`, `mount`, `direct`, `resolve`, general `match`, shallow routing and other unsupported DSL forms remain outside this static slice unless represented by runtime route snapshots.

### Laravel
- Dynamic route macros and variable/computed URIs remain unknown.
- Compound or non-conventional resource parameter naming is not guessed.
- Implicit Eloquent table/primary key naming remains unknown.

### Symfony
- This slice parses PHP `Route` attributes.
- YAML/XML/PHP config route definitions require a separate config importer.
- An attribute with no finite explicit HTTP method set is not guessed as GET.

## Certification statement

At this revision, T07 has evidence for:

- source-backed Ruby/PHP DSL discovery,
- bounded static route expansion,
- explicit Rails/Laravel model metadata,
- runtime-export **ingestion**,
- static/runtime comparison mechanics,
- exact-SHA static corpus execution,
- focused and repository-wide CI.

It does **not** yet claim:

- target-application runtime execution on the nine external repositories,
- runtime equivalence between static candidates and real Rails/Laravel/Symfony route tables,
- registration of Laravel/Symfony as stable bskel adapters,
- stable contract/capability changes,
- provider/codegen support.

Those require the separate runtime/integration tracks and their approvals.
