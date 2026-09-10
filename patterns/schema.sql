-- D-pattern-accrual: the sbf_pattern table `bskel new --record-pattern` writes to and
-- `bskel pattern list/show/suggest` read from. This is a database YOU own for YOUR OWN
-- projects' conventions -- bskel never creates it automatically (D-migration-scope: the same
-- "detect the missing table, name this exact file, never auto-DDL" posture handles/migration.sql.tmpl
-- already established for sbf_handle/sbf_handle_snapshot). Run this by hand, once, against
-- whatever Postgres database --pattern-database-url-env will point at.
--
-- `params` is JSONB, not one column per parameter, because the accepted parameter set differs
-- per stack (new/index.mjs's reusableParams) and grows independently of this table's own schema --
-- adding a stack, or widening a stack's reusableParams, needs zero migration here.
CREATE TABLE IF NOT EXISTS sbf_pattern (
	pattern_id UUID PRIMARY KEY,
	stack TEXT NOT NULL,
	params JSONB NOT NULL,
	recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sbf_pattern_stack_idx ON sbf_pattern (stack);
