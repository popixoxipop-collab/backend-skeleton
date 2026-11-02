# T10-04 differential and security test evidence

This is the persistence-plane read boundary, not framework runtime certification or
T20 OS-level permission enforcement. The product remains read-only (`write: false`).

## Executable assertions

`test/persistence-next/differential-security.test.mjs` supplies nine CI-discovered
cases:

- Source/live differential control, physical-naming mismatch and tenant A/B schema
  mismatch are checked through both `comparePersistenceIr` and binding verification.
  A logical `users` table cannot verify a physical `app_users` table; an explicit
  `tenant_a.users` source cannot verify `tenant_b.users`.
- A resource requesting admin/write permission, or a forged binding capability with
  `write: true`, cannot make certification's `scopes.write` true. This is a T10
  functional permission boundary, not a filesystem/OS sandbox test.
- Exact provider and snapshot authority are required for live verification.
- Four actual product-source mutants are loaded as isolated temporary modules.
  Removing the provider check, removing the snapshot check, ignoring ordered
  composite-key position, or changing the binding's `write: false` to `true`
  makes the same probe fail. The unmodified control must pass before each mutant
  is counted. The test asserts each mutation target occurs exactly once.
- The Prisma 6.19.0/7.0.0 fixture pair exercises the documented move of the
  datasource URL from `schema.prisma` to `prisma.config.ts`. Both versions must
  yield the same scoped physical table, mapped key and fields. T10 never runs
  the config or infers a database connection from it.

The pinned version/fixture hashes are in
`test/persistence-next/fixtures/versioned/VERSION_PINS.json`. The official
version boundary is documented in the [Prisma 7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7).
The GitHub annotated tag objects and resolved commits are `6.19.0`:
`f7050711d4b6a261fda50fc0602cb58ecb184817` →
`d4ec055ee9e13e62351bf72643fc978b3d315ae3`, and `7.0.0`:
`6843af9e3ab0d03357e064d9c96d579d3c6f6d97` →
`177882704271b747b3618b0cf6790e46f2432b7a`.

## Bob CLI syntax-validation receipt (2026-11-02)

Host: `BOB.local`, arm64 macOS. The three hand-authored fixture files transferred
from this PR were SHA-256 matched to their pinned values before execution.
Separate temporary project directories installed `prisma@6.19.0` and
`prisma@7.0.0` with `dotenv@17.2.3`; the latter also installed `node@24.13.0`.
Both validations used that Node 24.13.0 binary and a dummy localhost URL;
neither opened a database connection.

| CLI and schema | Exit | Observed output |
| --- | ---: | --- |
| Prisma 6.19.0, `validate --schema prisma/schema.prisma` | 0 | `The schema at prisma/schema.prisma is valid` |
| Prisma 7.0.0, `validate --schema prisma/schema.prisma` | 0 | `Loaded Prisma config from prisma.config.ts` and `The schema at prisma/schema.prisma is valid` |

The npm installation warned that its install scripts were not approved; the
`validate` commands nevertheless completed successfully. The first v7 install
also warned that Bob's default Node 26 was outside Prisma 7.0.0's supported
range. That default Node was **not** used for either recorded validation.
Neither validation generated Prisma Client, restored a locked dependency graph,
tested live SQL, or proved compatibility beyond these two authored schemas.

## Remaining boundaries

These tests do not grant a new ORM provider, generation/write permission,
framework runtime equality, tenant-isolation enforcement, independent
attestation, target certification, or a release gate. T10-05/-06 and target
`-02`/`-03` tasks retain their own gates.
