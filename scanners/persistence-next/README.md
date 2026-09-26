# Persistence Next — T10 Slice 1

This directory is an opt-in persistence normalization layer. It does not replace the current
`scanners/db/*` implementation and does not change existing adapter output.

Slice 1 now provides these conservative boundaries:

1. `sbf.persistence-ir/1`: common Entity/Table/PrimaryKey/Field/Relation facts with provenance.
2. Legacy bridges for JPA/Spring, SQLModel/FastAPI, TypeORM/Express and explicit Rails entity facts,
   mapped to persistence identities `jpa-hibernate`, `sqlalchemy-sqlmodel`, `typeorm` and
   `active-record`.
3. Existing Plane A migration and Plane C live Postgres facts projected into the same IR without
   erasing the distinction between unknown facts and observed absence.
4. Explicit resource→entity binding only. Name/table similarity never creates a binding.
5. Live verification of the physical table, ordered primary-key columns and available key type
   before a binding can become `verified_read_by_primary_key`.
6. Prisma source facts for explicit default schema candidates, including mapped single/composite
   keys and explicit relation field/reference pairs.
7. ActiveRecord source facts for literal `self.table_name`, `self.primary_key` and explicit
   local-FK `belongs_to` declarations.
8. Django ORM source facts for direct `models.Model` declarations with explicit table/key/column
   facts and conservative direct ForeignKey/OneToOneField handling.
9. A bridge from T07's real `sbf.model-facts/1` output, so Rails and Eloquent facts can be consumed
   without duplicating the T07 Ruby/PHP parser.
10. A provisional `bskel.internal.persistence-source-facts/0` input boundary for language agents
    such as T08 to hand EF Core/GORM facts to T10 without T10 reimplementing C#/Go parsing.
11. `sbf.persistence-generation-handoff/1`, which emits a T14-compatible provider/persistence/key
    tuple only after the persistence read is live-verified and the key is a single UUID.

## Explicit non-claims

Prisma Slice 1 does **not** claim schema-folder/multi-file resolution, Prisma Client runtime
metadata, implicit relation reconstruction, or generated handles support.

ActiveRecord does **not** claim Rails inflection, STI, polymorphic target resolution, scopes,
callbacks, runtime column discovery, or an implicit `id`.

Django does **not** claim app-label table-name reconstruction, implicit `id`, arbitrary custom
Field subclasses, GenericForeignKey, swappable models, inherited model semantics, or runtime
`_meta` equivalence.

The T07 Eloquent bridge only consumes T07 facts. It does not duplicate PHP parsing, and it emits a
physical relation only where the supplied facts contain an explicit local foreign key and an
unambiguous target with an explicit physical table.

EF Core/GORM/Diesel do not have T10-owned language parsers in this slice. Their language agents
must supply the provisional source-facts boundary (or a reviewed successor) with physical table,
ordered key, field and relation provenance. Drizzle/Sequelize likewise wait for richer JS/TS
semantic facts rather than being rebuilt as a second T04 parser.

No provider in this directory grants write generation, DDL apply, authorization, tenant scope or
migration safety. T14 still owns the explicit generation-combination allowlist; a verified Prisma,
ActiveRecord, Eloquent or Django mapping remains blocked there until T14 separately approves it.

## Live-DB limitation

Current Postgres introspection exposes foreign keys as flat rows without retained constraint
identity/ordinal pairing. When several rows target the same parent, this layer preserves the
observed columns but marks the relation `ambiguous-flat-introspection`; it does not fabricate a
composite pairing.
