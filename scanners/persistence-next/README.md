# Persistence Next — T10 Slice 1

This directory is an opt-in persistence normalization layer. It does not replace the current
`scanners/db/*` implementation and does not change existing adapter output.

Slice 1 provides seven deliberately conservative pieces:

1. `sbf.persistence-ir/1`: common Entity/Table/PrimaryKey/Field/Relation facts with provenance.
2. Bridges for existing ORM-bearing adapter outputs (JPA/Spring, SQLModel/FastAPI,
   TypeORM/Express, and explicit ActiveRecord facts emitted by Rails), plus the existing migration
   scan and live Postgres introspection.
3. Resource binding that accepts only an exact `entity_ref` or an explicit binding. Similar class,
   resource, module or table names are never sufficient to create a binding.
4. Read-only source/migration/live drift comparison. Unknown evidence stays unknown instead of
   becoming a guessed table, key or relation.
5. A Prisma source provider for explicit default schema candidates, including mapped single/
   composite keys and explicit relation field/reference pairs.
6. An ActiveRecord source provider that accepts literal `self.table_name`,
   `self.primary_key`, and explicit `belongs_to class_name:/foreign_key:` facts.
7. A Django ORM source provider for direct `models.Model` classes. It accepts explicit
   `Meta.db_table`, direct built-in field declarations, `primary_key=True`, `db_column`,
   and direct ForeignKey/OneToOneField facts.

Prisma Slice 1 does **not** claim schema-folder / multi-file cross-file resolution, Prisma Client
runtime metadata, implicit relation reconstruction, or code generation.

ActiveRecord Slice 1 does **not** claim default pluralization/inflection, STI resolution,
polymorphic associations, scopes/callbacks, database column discovery, or implicit foreign keys.

Django Slice 1 does **not** claim app-label table-name reconstruction, implicit `id` materialization,
custom model bases/managers, arbitrary custom Field subclasses, GenericForeignKey, swappable model
resolution, or runtime `_meta` equivalence. Direct ForeignKey columns may use Django's direct
`<field>_id` source default, but runtime read verification still requires the live DB table/PK
evidence path.

Not in Slice 1: EF Core/GORM/Eloquent/Drizzle/Sequelize/Diesel source providers, write generation,
migration apply, authorization, tenant inference, or CLI wiring. Those belong to later T10/T14
target tasks after the common IR and each provider scope are reviewed.

Important live-DB limitation: the current Postgres introspection exposes foreign keys as flat rows
without retained constraint identity/ordinal pairing. When more than one row targets the same
parent table, this bridge preserves raw columns but marks the relation
`ambiguous-flat-introspection`; it does not fabricate a composite-key pairing.
