# Persistence Next — T10 Slice 1

This directory is an opt-in persistence normalization layer. It does not replace the current
`scanners/db/*` implementation and does not change existing adapter output.

Slice 1 provides six deliberately conservative pieces:

1. `sbf.persistence-ir/1`: common Entity/Table/PrimaryKey/Field/Relation facts with provenance.
2. Bridges for the existing ORM-bearing adapter outputs (JPA/Spring, SQLModel/FastAPI,
   TypeORM/Express, and the explicit ActiveRecord facts already emitted by Rails), plus the
   existing migration scan and live Postgres introspection.
3. Resource binding that accepts only an exact `entity_ref` or an explicit binding. Similar class,
   resource, module or table names are never sufficient to create a binding.
4. Read-only source/migration/live drift comparison. Unknown evidence stays unknown instead of
   becoming a guessed table, key or relation.
5. A Prisma source provider for explicit default schema candidates. It extracts model/table/column
   mappings, keys and explicit relation pairings while refusing ambiguous schema roots.
6. An ActiveRecord source provider that accepts literal `self.table_name`,
   `self.primary_key`, and explicit `belongs_to class_name:/foreign_key:` facts. Rails
   inflection and conventional `id` are deliberately not reimplemented.

Prisma Slice 1 does **not** claim Prisma schema-folder / multi-file cross-file resolution, runtime
Prisma Client metadata, implicit relation reconstruction, database-native behavior beyond the
parsed declarations, or code generation. Unknown/custom field types and unresolved relation
targets remain diagnostics rather than fabricated physical fields/edges.

ActiveRecord Slice 1 does **not** claim default pluralization/inflection, STI resolution, polymorphic
association resolution, scopes, callbacks, database column discovery, or implicit foreign keys.
Those require migration/live DB evidence or a separately approved Rails runtime metadata exporter.

Not in Slice 1: Django/EF Core/GORM/Eloquent/Drizzle/Sequelize/Diesel source providers, write
generation, migration apply, authorization, tenant inference, or CLI wiring. Those belong to
later T10/T14 target tasks after the common IR and each provider scope are reviewed.

Important live-DB limitation: the current Postgres introspection exposes foreign keys as flat rows
without a retained constraint identity/ordinal pairing. When more than one row targets the same
parent table, this bridge preserves the raw columns but marks the relation
`ambiguous-flat-introspection`; it does not fabricate a composite-key pairing.
