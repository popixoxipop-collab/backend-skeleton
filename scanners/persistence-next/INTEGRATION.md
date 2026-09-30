# T10 Integration Contract

This note describes the boundary T10 needs from language/semantic analysis tracks. It is not a
stable cross-tool SBF contract; T01 owns any later promotion. The current provisional wire shape is
`bskel.internal.persistence-source-facts/0`.

## Why this boundary exists

T10 owns persistence semantics and source/migration/live reconciliation. It should not grow a
second C#, Go, Rust or JS/TS parser. T04/T08 (and later language tracks) should emit source-backed
facts; T10 converts those facts into `sbf.persistence-ir/1`, performs explicit resource binding
and then verifies the physical mapping against live DB evidence.

## Required entity facts

Each emitted entity must carry:

- a repository-relative source file and optional line;
- logical entity name and optional module;
- physical table/schema with basis `explicit`, `default`, or `unknown`;
- ordered physical primary-key columns with the same basis distinction;
- physical fields with type/nullability where known;
- relations with ordered local columns, target physical table/schema, ordered target columns, and
  pairing status `resolved` or `unknown`;
- explicit unknown diagnostics when a compiler/language backend cannot prove a fact.

A name with `basis: unknown` is forbidden. Unknown means no physical name is emitted.

## `persistence_id` admission

`persistence_id` must exactly match a `catalog.mjs` target id (case- and whitespace-sensitive); an
unregistered id is rejected at this boundary. A target in `blocked-upstream-facts` is still
accepted, because this boundary is how the facts it waits for will arrive:

- EF Core and GORM wait for T08 persistence semantic facts (CR-T10-002);
- Drizzle and Sequelize wait for T04 declaration/call semantic facts (CR-T10-003);
- Diesel waits for T08 Rust semantic/compiler facts, which are not available in the current
  native-server pilot (`CHANGE_REQUESTS.md` has no CR for it).

The IR of a blocked target carries a `persistence-target-blocked` warning diagnostic and
`metadata.persistence_target_state`. Certification, generation handoff and conformance look the id
up in the catalog (not the marker) and report `persistence-target-not-admitted` until the catalog
state becomes `implemented-draft`: certification and handoff stay `blocked` instead of reaching
`runtime-read-verified` / `ready`, and conformance fails with `certified_scope: null`. Any other id
that is not an admitted catalog target, including one on an IR built directly with
`createPersistenceIr`, gets the same result there.

## T08 request: EF Core and GORM

The current T08 foundation emits HTTP route facts only. A persistence follow-up should emit this
boundary from C#/Go semantic analysis instead of making T10 parse those languages.

For EF Core, the useful minimum is explicit/verified model class identity, `ToTable`/table
attribute mapping, ordered keys, column mapping and direct FK target/column pairs. Fluent
configuration overrides must either be incorporated with provenance or reported unknown.

For GORM, the useful minimum is struct identity, explicit/default table and column mappings,
ordered primary-key fields, embedded-field provenance and explicit relation/FK mappings. Naming
strategies or runtime plugin behavior that cannot be reproduced statically must remain unknown.

## T04 request: Drizzle and Sequelize

The current T04 source-facts layer is intentionally limited to module edges, so it is not enough to
certify Drizzle or Sequelize persistence semantics. A later T04 semantic layer should provide
call/declaration facts for physical table/column/key/relation declarations. Until then T10 will not
ship a competing TypeScript parser merely to add ORM names.

## T07 integration

T07 already emits `sbf.model-facts/1` for ActiveRecord/Eloquent. T10 consumes that contract through
`model-facts-bridge.mjs`; T10 does not duplicate Eloquent parsing. Polymorphic and implicit naming
remain unknown.

## T14 handoff

T10 does not approve code generation combinations. After an explicit resource/entity binding is
verified against live persistence evidence, `generation-handoff.mjs` emits
`sbf.persistence-generation-handoff/1` with T14's current `providerId/persistenceId/keyType`
vocabulary. T14's catalog remains the final fail-closed allowlist.
