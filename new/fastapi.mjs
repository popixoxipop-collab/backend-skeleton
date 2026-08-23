// P2 (D-greenfield-bootstrap): unlike Spring, FastAPI has no first-party scaffolding CLI/service
// with comparable official standing to Spring Initializr (confirmed while researching this item)
// -- so "pinned starter" here means a minimal, LOCAL, hand-written template matching the exact
// layout scanners/adapters/python-fastapi.mjs's own detectPythonFastApiRoot() already expects
// (a pyproject.toml declaring a `fastapi` dependency + a .py file that imports/instantiates it),
// not a third-party generator. No network call.
//
// P2b (D-greenfield-parameters): this is the half of `bskel new` with NO upstream authority at all
// -- there is no Initializr here to bounce a bad value back, so every value this file writes is one
// `bskel` itself is the last check on. Two consequences, both deliberate: the {{VAR}} renderer is
// now the shared one (lib/template.mjs), and every rendered file is scanned for a SURVIVING {{VAR}}
// before anything reaches disk -- a scaffold that would ship a literal `{{FOO}}` into a user's
// pyproject.toml fails CLOSED instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplateText, findResidualTemplateVars } from '../lib/template.mjs';

const DEFAULT_TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates', 'fastapi');

export const DEFAULT_PROJECT_VERSION = '0.1.0';
export const DEFAULT_REQUIRES_PYTHON = '>=3.11';
export const DEFAULT_PORT = '8000';
export const DEFAULT_DATABASE = 'none';

// P2b: the driver pin, and ONLY the driver pin. `--database` never generates engine/session wiring,
// a db.py, or a models package -- that would be `bskel` inventing the user's domain, the same line
// `D-resolver-scope` draws for patchField() and `D-javascript-express-adapter`'s Phase 2 draws for
// generated SQL. sqlite needs no third-party driver at all (CPython ships sqlite3, and SQLModel/
// SQLAlchemy drive it through the stdlib module), so it correctly adds nothing.
const DATABASE_DEPENDENCIES = Object.freeze({
	postgres: ['psycopg[binary]>=3.2'],
	sqlite: [],
	none: [],
});

// TOML basic strings and Python double-quoted strings share the two escapes that matter here.
// Newlines/control characters are rejected upstream (new/params.mjs's requireSingleLineText), so a
// backslash and a double quote are the whole surface.
function escapeQuoted(value) {
	return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function buildVars({ slug, name, description, projectVersion, requiresPython, port, license, database }) {
	const resolvedName = name ?? slug;
	const resolvedDatabase = database ?? DEFAULT_DATABASE;
	const driverLines = (DATABASE_DEPENDENCIES[resolvedDatabase] ?? [])
		.map((dep) => `    "${escapeQuoted(dep)}",\n`)
		.join('');

	const databaseSection = resolvedDatabase === 'none' ? '' : [
		'## Database',
		'',
		resolvedDatabase === 'postgres'
			? '`--database postgres` pinned `psycopg[binary]` in `pyproject.toml`. That is all it did.'
			: '`--database sqlite` pinned no extra driver -- CPython ships `sqlite3`, which SQLModel/SQLAlchemy drive directly.',
		'',
		'No engine, session, or connection code was generated: the connection URL, pooling, migrations',
		'and session lifecycle are decisions about your application, not ones a scaffolder should make',
		'for you. Wire them up yourself before adding models.',
		'',
		'',
	].join('\n');

	return {
		SLUG: slug,
		NAME: escapeQuoted(resolvedName),
		DESCRIPTION: escapeQuoted(description ?? ''),
		PROJECT_VERSION: escapeQuoted(projectVersion ?? DEFAULT_PROJECT_VERSION),
		REQUIRES_PYTHON: escapeQuoted(requiresPython ?? DEFAULT_REQUIRES_PYTHON),
		// A whole line, including its trailing newline, so an absent --license leaves no blank line
		// behind. There is no neutral default SPDX identifier -- emitting one would be this tool
		// asserting a legal claim the user never made -- so the key is omitted entirely instead.
		LICENSE_LINE: license == null ? '' : `license = "${escapeQuoted(license)}"\n`,
		DATABASE_DEPENDENCY_LINES: driverLines,
		DESCRIPTION_BLOCK: description ? `${description}\n\n` : '',
		PORT: String(port ?? DEFAULT_PORT),
		DATABASE_SECTION: databaseSection,
	};
}

// Renders the whole tree into memory FIRST, so the residual-variable check below can fail before a
// single byte reaches disk. Deliberately not "write, then verify, then delete": `dir` comes from
// user input (`--dir`), and an rm -rf of a user-supplied path to clean up after our own bug is a
// worse failure mode than the bug. Nothing partial ever exists.
function renderTree(srcDir, destDir, vars) {
	const files = [];
	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const srcPath = path.join(srcDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...renderTree(srcPath, path.join(destDir, entry.name), vars));
			continue;
		}
		// The template's own gitignore is named without a leading dot (see new/templates/fastapi/
		// gitignore) so this repo's own tooling never treats it as a real, active .gitignore.
		const destName = entry.name === 'gitignore' ? '.gitignore' : entry.name;
		files.push({
			destPath: path.join(destDir, destName),
			content: renderTemplateText(fs.readFileSync(srcPath, 'utf8'), vars),
		});
	}
	return files;
}

export async function scaffoldFastapi({
	dir,
	slug,
	name = null,
	description = null,
	projectVersion = null,
	requiresPython = null,
	port = null,
	license = null,
	database = null,
	// Internal test seam only -- never wired to a CLI flag. `test/new-cli.test.mjs` points this at a
	// deliberately broken template to prove the fail-closed check below can actually fail.
	templateDir = DEFAULT_TEMPLATE_DIR,
} = {}) {
	if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
		throw new Error(`${dir} already exists and is not empty -- refusing to scaffold into it`);
	}

	const vars = buildVars({ slug, name, description, projectVersion, requiresPython, port, license, database });
	const files = renderTree(templateDir, dir, vars);

	// P2b: the fail-closed half. P4's `bskel catalog lint` has run this same check over
	// stack/catalog/ templates since D-extension-conformance; new/templates/** never had it, so a
	// template variable added without a matching entry in buildVars() above would have shipped a
	// literal `{{FOO}}` into a real user's pyproject.toml with nothing to catch it.
	const offenders = files
		.map((f) => ({ rel: path.relative(dir, f.destPath), tokens: findResidualTemplateVars(f.content) }))
		.filter((f) => f.tokens.length > 0);
	if (offenders.length > 0) {
		const detail = offenders.map((f) => `${f.rel}: ${f.tokens.join(', ')}`).join('; ');
		throw new Error(`bskel-internal: the fastapi template left unsubstituted variable(s) after rendering (${detail}) -- refusing to write a project containing literal template tokens. Nothing was written.`);
	}

	for (const f of files) {
		fs.mkdirSync(path.dirname(f.destPath), { recursive: true });
		fs.writeFileSync(f.destPath, f.content);
	}

	const resolvedDatabase = database ?? DEFAULT_DATABASE;
	const postScaffoldNotes = [];
	if (resolvedDatabase !== 'none') {
		// Accurate per choice: postgres really did add a dependency line, sqlite deliberately added
		// nothing at all (CPython ships sqlite3). Saying "pinned the driver" for sqlite would be a
		// small lie in exactly the place this note exists to prevent one.
		const did = resolvedDatabase === 'postgres'
			? 'pinned psycopg[binary] in pyproject.toml'
			: 'pinned no extra dependency (CPython ships sqlite3, which SQLModel/SQLAlchemy drive directly)';
		postScaffoldNotes.push(`--database ${resolvedDatabase} ${did}. That is all it did. NOT done automatically: the engine, session and connection-URL wiring, or any migration setup -- see the "Database" section of the generated README.md.`);
	}

	return {
		dir,
		name: name ?? slug,
		projectVersion: projectVersion ?? DEFAULT_PROJECT_VERSION,
		requiresPython: requiresPython ?? DEFAULT_REQUIRES_PYTHON,
		port: String(port ?? DEFAULT_PORT),
		license: license ?? null,
		database: resolvedDatabase,
		postScaffoldNotes,
	};
}
