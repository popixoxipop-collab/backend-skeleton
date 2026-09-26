# T10 Cross-Track Change Requests

## CR-T10-001 — expose nested persistence tests to required CI

**Owner requested:** T00/T23 (integration/release CI).

**Reason:** root `npm test` expands `test/*.test.mjs`, while T10's assigned test namespace is
`test/persistence-next/**`. Current GitHub CI can therefore be green without running T10 tests.

**Requested implementation:** add a tiny root-level test bridge owned by the integration/release
track (same pattern already used by other scale tracks), or add an explicit nested test command to
the required CI lane.

**Acceptance:**

1. PR head CI executes every `test/persistence-next/*.test.mjs` file.
2. Failure in a nested T10 assertion makes the required job fail.
3. No T10 code needs to move into the shared root test namespace.
4. The exact CI head SHA is recorded before the draft PR becomes ready.

## CR-T10-002 — T08 persistence semantic facts

**Owner requested:** T08.

Add EF Core/GORM semantic facts conforming to, or explicitly superseding,
`bskel.internal.persistence-source-facts/0`. Do not grant runtime support from route facts alone.

## CR-T10-003 — T04 ORM semantic facts

**Owner requested:** T04.

Add source-backed declaration/call facts sufficient for Drizzle/Sequelize physical table, key,
column and relation extraction. T10 will consume those facts instead of creating a second JS/TS
parser.
