# T10 Status — Persistence / DB Plane

Status is **implemented in draft, not accepted/released**. PR #84 remains draft.

| T10 task | Current state | Concrete output | Remaining gate |
|---|---|---|---|
| T10-01 existing DB baseline | implemented | `BASELINE.md`, bridges keep Plane A/Plane C separate | current-head nested-suite CI visibility |
| T10-02 Persistence IR | implemented | `sbf.persistence-ir/1`, provenance, ordered keys/relations | interface review with T01/T03 |
| T10-03 binding composer | implemented | explicit `entity_ref`/binding only; ORM identity carried | consumer review |
| T10-04 read-only DB verification | implemented | live table + ordered PK + available key-type verification | live fixture/corpus expansion |
| T10-05 ORM contract slice | implemented for admitted slice | JPA/SQLModel/TypeORM legacy bridges, Prisma, ActiveRecord, Django, T07 Rails/Eloquent bridge | long-tail facts from T04/T08; provider corpus certification |
| T10-06 generation scope certification | implemented | scoped certification + T14-compatible handoff; write always false | T14 catalog remains final allowlist |

## Verified boundaries

Earlier in the session, on EOE at the then-current T10 head:

- T10 tests: 39 passed / 0 failed.
- existing DB/migration/ERD/cross-feature regression set: 78 passed / 0 failed.
- `git diff --check`: clean.

After the EOE connector disappeared from the session, later branch revisions were re-read from
GitHub and exercised through isolated source checks for:

- legacy adapter → ORM identity → explicit binding → live UUID verification → T14 handoff;
- source/live key-type contradiction fail-closed;
- ActiveRecord and Django explicit/unknown/relation edge cases;
- actual T07 `sbf.model-facts/1` Rails/Eloquent output → T10 bridge;
- T14 current legacy catalog compatibility and unapproved Prisma rejection;
- provisional language-neutral persistence source-facts validation;
- certification split between runtime-read verification and T14 generation approval;
- syntax compilation of every T10 implementation module in the GitHub branch.

These isolated checks are useful evidence, but they do not replace a real Node execution of the
current nested test suite.

## CI limitation

Repository `npm test` currently expands `test/*.test.mjs`; T10 tests are under
`test/persistence-next/*.test.mjs`. A green current CI therefore does not, by itself, prove that
the nested T10 suite ran. CR-T10-001 requests a T00/T23-owned root bridge or explicit required CI
command.

## Cross-track dependencies

- T07 already supplies `sbf.model-facts/1`; T10 consumes it for Rails/Eloquent.
- T14 current approved generation combinations are the three legacy UUID stacks; T10 never extends
  that allowlist implicitly.
- T08 currently supplies Go/C# HTTP route facts, not persistence semantics. EF Core/GORM wait for
  CR-T10-002 rather than being re-parsed inside T10.
- T04 current JS/TS facts are module-edge focused. Drizzle/Sequelize wait for CR-T10-003 rather than
  receiving a second T10 TypeScript parser.

See `INTEGRATION.md`, `TESTING.md`, and `CHANGE_REQUESTS.md`.
