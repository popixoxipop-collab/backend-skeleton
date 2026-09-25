# T10 Persistence / DB Plane Baseline

Baseline commit: `5472a8b82655840d1d3ce76cb926987376e37ca6`.

This note records what Slice 1 consumes without changing the stable paths.

## Existing planes

- Plane A: `scanners/db/migrations.mjs` detects Flyway/Liquibase files. Its SQL extraction records
  table names, column names and supported single-column foreign-key evidence. It does not claim
  primary-key/type/nullability facts for the migration plane.
- Plane C: `scanners/db/introspect.mjs` performs read-only Postgres introspection and returns
  schema/table/column/primary-key/foreign-key/index/RLS-policy facts. Current foreign-key output is
  flat per-column evidence and does not retain enough constraint identity/ordinal data to reconstruct
  every composite or multiple-FK pairing safely.
- `scanners/db/erd.mjs` already preserves the Plane A/Plane C distinction and documents degraded
  information rather than guessing it.

## Existing ORM-bearing adapter facts

- `java-spring`: JPA entity class, explicit table when `@Table(name=...)` is present, ID field/type,
  UUID suitability.
- `python-fastapi`: SQLModel `table=True` entity, explicit/inferred table provenance, ID field.
- `typescript-express`: TypeORM entity, explicit/inferred table provenance, ID field and UUID
  suitability.

The Persistence Next bridge copies these facts into a separate IR. It does not modify those adapter
outputs or reinterpret an absent fact as known.

## Slice 1 invariants

1. Unknown physical table/key/relation evidence stays unknown.
2. Resource-to-entity binding is explicit: exact `entity_ref` or explicit binding only.
3. Names and similar table names are not implicit bindings.
4. Source, migration and live observations remain separately comparable.
5. Generation is read-only in this slice; write/migration/auth/tenant behavior is not granted.
6. Stable `scanners/db/*`, adapter and handles paths remain untouched by T10 Slice 1.
