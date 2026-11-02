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

## CR-T10-004 — T08 Rust/Diesel persistence semantic and compiler facts

**Owner requested:** T08 Rust semantic/compiler analysis. **Status:** requested, not delivered.

T10 must not build a second Rust parser. T08 should emit source-backed facts conforming to,
or explicitly superseding, `bskel.internal.persistence-source-facts/0` for exact Diesel
`v2.3.14` before the catalog's `diesel` entry can leave `blocked-upstream-facts`.

**Requested minimum:** pin the Cargo feature/dependency graph and `table!` expansion;
retain source/provenance for physical schema/table, `#[sql_name]` columns, ordered
composite primary keys, `#[diesel(table_name)]` and `#[diesel(primary_key)]` derives,
and `joinable!` / association pairs. Distinguish explicit/default/unknown basis and
compiler-conditional branches. Report diagnostics rather than inventing facts when
macro expansion fails, migrations/schema.rs drift, a composite FK cannot be represented
by `joinable!`, or a connection's `search_path` makes the physical schema runtime-bound.

**Acceptance:** T08 provides an exact-version fixture and compile/provenance receipts
for normal and negative cases, and T10 can consume them without parsing Rust source
or changing the Diesel catalog state before T16/T19/T20 and live-DB checks. This CR
does not claim T08 delivery, a Diesel provider, certification, or release approval.
