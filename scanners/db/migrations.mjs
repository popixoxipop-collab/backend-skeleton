// A4 (D-db-schema-plane): Plane A -- migration-file scanning, always local, never a network call.
// Deliberately NOT a real SQL parser -- same "good-enough regex, not a real parser" restraint as
// A2's Java analyzer and G2's Python analyzer, bounded to what real Flyway/Liquibase repos
// actually look like, not general SQL. Confirmed against the real oracle repo (Team-IZ-Backend)
// that it has ZERO migration files of either kind -- this module is unverifiable against it and
// is built/tested entirely against a synthetic fixture instead (see DECISIONS.md D-db-schema-plane).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function listRgFiles(repoRoot, glob) {
	try {
		return execFileSync('rg', ['--files', '-g', glob, repoRoot], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
	} catch {
		return []; // rg exits 1 on "no files matched" -- not an error
	}
}

// Same balanced-paren algorithm as python-fastapi.mjs's own local matchBalancedParens() and
// _java-spring-analyzer.mjs's matchBalanced() -- a third, deliberately separate copy, matching
// this project's own established precedent (see python-fastapi.mjs's own comment) of NOT reaching
// across an unrelated module boundary for a five-line algorithm; SQL is a different language from
// either of those, sharing the module would be a false economy.
function matchBalancedParens(text, openIndex) {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

// Splits a column-definition list on top-level commas only -- `VARCHAR(255)`/`NUMERIC(10,2)`/
// `CHECK (price > 0)` all carry their own parens that must not be mistaken for a column separator.
function splitTopLevelCommas(text) {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')') depth = Math.max(0, depth - 1);
		else if (text[i] === ',' && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	const last = text.slice(start);
	if (last.trim()) parts.push(last);
	return parts.map((p) => p.trim()).filter(Boolean);
}

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s*\(/gi;
const ALTER_ADD_COLUMN_RE = /ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
// A column definition line's own leading constraint keywords never name a column -- skips them so
// e.g. `PRIMARY KEY (id, org_id)` isn't mistaken for a column named "primary".
const CONSTRAINT_LEAD_RE = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;
const COLUMN_NAME_RE = /^"?(\w+)"?/;

// D-cross-feature-fk-inference (Plane A FK extraction): closes this project's own named EXIT item
// ("Plane A (migration-file) FK extraction is out of scope") -- `--db` alone (no
// `--database-url-env`) now contributes real FK data to the `db_foreign_key` cross-feature signal
// via a real, disposable Postgres connection's absence, using nothing but migration-file text.
// Same "good-enough regex, not a real parser" restraint as everything else in this module --
// single-column FKs only; a composite `FOREIGN KEY (a, b) REFERENCES ...` segment simply doesn't
// match either regex below and is silently skipped, the same fail-safe-by-omission behavior
// CONSTRAINT_LEAD_RE's own unmatched segments already have.
//
// Table-level: `FOREIGN KEY (col) REFERENCES other_table (ocol)` -- ocol is optional (references
// the parent's PK when omitted; genuinely rare in real migrations, still handled).
const TABLE_LEVEL_FK_RE = /^FOREIGN\s+KEY\s*\(\s*"?(\w+)"?\s*\)\s+REFERENCES\s+"?(\w+)"?\s*(?:\(\s*"?(\w+)"?\s*\))?/i;
// Inline column-level: applied to a column-definition segment ALREADY matched by COLUMN_NAME_RE --
// `col_name TYPE ... REFERENCES other_table(ocol)` or bare `REFERENCES other_table`. When ocol is
// omitted, references_column is left `null` -- the referenced PK's real column name is genuinely
// unknowable from the migration file alone, and guessing "id" would be a false-confidence
// fabrication this project has repeatedly refused to ship elsewhere.
const INLINE_REFERENCES_RE = /REFERENCES\s+"?(\w+)"?\s*(?:\(\s*"?(\w+)"?\s*\))?/i;
// `ALTER TABLE t ADD CONSTRAINT name FOREIGN KEY (col) REFERENCES other_table (ocol)` -- a very
// common Flyway pattern for adding a constraint in a LATER migration than the table's own CREATE.
const ALTER_ADD_FK_RE = /ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+CONSTRAINT\s+"?\w+"?\s+FOREIGN\s+KEY\s*\(\s*"?(\w+)"?\s*\)\s+REFERENCES\s+"?(\w+)"?\s*(?:\(\s*"?(\w+)"?\s*\))?/gi;

function newTableEntry() {
	return { columns: new Set(), foreignKeys: [] };
}

// D-ddl-apply: exported (was module-private) so scanners/db/ddl-apply.mjs's postcondition check
// can reuse this exact extraction instead of a second copy -- it needs to know which table
// name(s) a proposed CREATE TABLE/ALTER TABLE ADD COLUMN statement declares, to assert the live,
// re-introspected schema actually reflects them after apply.
export function extractTablesFromSql(sqlText, sourceFile) {
	const tables = new Map(); // name -> {columns: Set, foreignKeys: Array}

	CREATE_TABLE_RE.lastIndex = 0;
	let m;
	while ((m = CREATE_TABLE_RE.exec(sqlText))) {
		const tableName = m[1];
		const openParen = m.index + m[0].length - 1;
		const closeParen = matchBalancedParens(sqlText, openParen);
		if (closeParen === -1) continue; // malformed -- skip, don't misattribute
		const body = sqlText.slice(openParen + 1, closeParen);
		if (!tables.has(tableName)) tables.set(tableName, newTableEntry());
		const entry = tables.get(tableName);
		for (const segment of splitTopLevelCommas(body)) {
			if (CONSTRAINT_LEAD_RE.test(segment)) {
				const fkMatch = segment.match(TABLE_LEVEL_FK_RE);
				if (fkMatch) {
					entry.foreignKeys.push({ column: fkMatch[1], references_table: fkMatch[2], references_column: fkMatch[3] ?? null });
				}
				continue;
			}
			const colMatch = segment.match(COLUMN_NAME_RE);
			if (!colMatch) continue;
			entry.columns.add(colMatch[1]);
			const inlineMatch = segment.match(INLINE_REFERENCES_RE);
			if (inlineMatch) {
				entry.foreignKeys.push({ column: colMatch[1], references_table: inlineMatch[1], references_column: inlineMatch[2] ?? null });
			}
		}
	}

	ALTER_ADD_COLUMN_RE.lastIndex = 0;
	while ((m = ALTER_ADD_COLUMN_RE.exec(sqlText))) {
		const [, tableName, columnName] = m;
		if (!tables.has(tableName)) tables.set(tableName, newTableEntry());
		tables.get(tableName).columns.add(columnName);
	}

	ALTER_ADD_FK_RE.lastIndex = 0;
	while ((m = ALTER_ADD_FK_RE.exec(sqlText))) {
		const [, tableName, column, referencesTable, referencesColumn] = m;
		if (!tables.has(tableName)) tables.set(tableName, newTableEntry());
		tables.get(tableName).foreignKeys.push({ column, references_table: referencesTable, references_column: referencesColumn ?? null });
	}

	return [...tables.entries()].map(([name, entry]) => ({
		name,
		columns: [...entry.columns].sort(),
		foreign_keys: entry.foreignKeys,
		source_file: sourceFile,
	}));
}

// Entry point. Returns `{ tool, files, tables, generated_at }` -- `tool: 'none'` (empty
// files/tables) is a real, expected, and reported outcome, not an error -- most real repos
// (including the oracle repo itself) have no migration-file convention at all; their schema lives
// elsewhere (JPA ddl-auto, or -- the oracle repo's actual case -- entirely outside this repo, in
// an external Supabase project). `generated_at` (D-cross-feature-fk-inference, staleness/freshness
// token) reflects when THIS scan ran -- stamped once, reused across all 3 return sites below, so a
// single call always reports one consistent timestamp regardless of which branch it takes.
export function scanMigrations(repoRoot) {
	const generatedAt = new Date().toISOString();
	const flywayFiles = listRgFiles(repoRoot, '**/db/migration/**/*.sql');
	const liquibaseFiles = listRgFiles(repoRoot, '**/db/changelog/**/*.{xml,yaml,yml,sql}');

	if (flywayFiles.length === 0 && liquibaseFiles.length === 0) {
		return { tool: 'none', files: [], tables: [], generated_at: generatedAt };
	}

	if (flywayFiles.length > 0) {
		const tables = [];
		for (const file of flywayFiles) {
			const text = fs.readFileSync(file, 'utf8');
			tables.push(...extractTablesFromSql(text, path.relative(repoRoot, file)));
		}
		return { tool: 'flyway', files: flywayFiles.map((f) => path.relative(repoRoot, f)), tables, generated_at: generatedAt };
	}

	// Liquibase changelogs are DETECTED (filenames recorded) but not deep-parsed in this first
	// pass -- XML/YAML changeSet parsing is a materially larger, separate job than Flyway's plain
	// SQL files; recording their presence is still real value over today's total silence, and is
	// an honestly documented gap, not a silent guess (see DECISIONS.md D-db-schema-plane).
	const sqlLiquibaseFiles = liquibaseFiles.filter((f) => f.endsWith('.sql'));
	const tables = [];
	for (const file of sqlLiquibaseFiles) {
		const text = fs.readFileSync(file, 'utf8');
		tables.push(...extractTablesFromSql(text, path.relative(repoRoot, file)));
	}
	return { tool: 'liquibase', files: liquibaseFiles.map((f) => path.relative(repoRoot, f)), tables, generated_at: generatedAt };
}
