# Persistence Next — T10 Slice 1

This directory is an opt-in persistence normalization layer. It does not replace the current
`scanners/db/*` implementation and does not change existing adapter output.

Slice 1 provides five deliberately conservative pieces:

1. `sbf.persistence-ir/1`: common Entity/Table/PrimaryKey/Field/Relation facts with provenance.
2. Bridges for the three legacy ORM-bearing adapter outputs (JPA/Spring, SQLModel/FastAPI,
   TypeORM/Express), the existing migration scan, and the existing live Postgres introspection.
3. Resource binding that accepts only an exact `entity_ref` or an explicit binding. Similar class,
   resource, module or table names are never sufficient to create a binding.
4. Read-only source/migration/live drift comparison. Unknown evidence stays unknown instead of
   becoming a guessed table, key or relation.
5. A first Prisma source provider for an explicit `prisma/schema.prisma` or root
   `schema.prisma`. It extracts model/table/column mappings, `@id`/`@@id`, `@@schema`,
   and explicit `@relation(fields: ..., references: ...)` pairings while preserving declared
   composite-key/relation order.

Prisma Slice 1 does **not** claim Prisma schema-folder / multi-file cross-file resolution, runtime
Prisma Client metadata, implicit relation reconstruction, database-native behavior beyond the
parsed declarations, or code generation. Unknown/custom field types and unresolved relation
targets remain diagnostics rather than fabricated physical fields/edges.

Not in Slice 1: Drizzle/Sequelize/etc. source scanners, write generation, migration apply,
authorization, tenant inference, or CLI wiring. Those belong to later T10/T14 target tasks after
the common IR and each provider scope are reviewed.

Important live-DB limitation: the current Postgres introspection exposes foreign keys as flat rows
without a retained constraint identity/ordinal pairing. When more than one row targets the same
parent table, this bridge preserves the raw columns but marks the relation
`ambiguous-flat-introspection`; it does not fabricate a composite-key pairing.
