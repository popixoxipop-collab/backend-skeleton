// P2b (D-greenfield-parameters): local validation for the `bskel new` parameters where letting
// Spring Initializr's own HTTP 400 be the check is NOT safe.
//
// The split is measured, not assumed (see the validation matrix in DECISIONS.md's
// D-greenfield-parameters): `dependencies`/`type`/`packaging`/`language` all fail CLOSED at
// start.spring.io with a clean, quotable 400 message, so those stay pass-through. `groupId`/
// `packageName` fail OPEN -- `groupId=com.new` (a JLS reserved word as a package segment) and
// `groupId=has space` both return HTTP 200 and a project that cannot compile -- so they need a real
// local validator. `javaVersion` also fails OPEN (`javaVersion=99` returns 200 and writes
// `JavaLanguageVersion.of(99)` straight into build.gradle), but its valid set is a MOVING external
// fact, so it is checked against a live metadata fetch rather than a local list (see below).
//
// Why a local Java validator does not go stale the way a local dependency-id or javaVersion list
// would: the Java package-name grammar (JLS 3.8) and the reserved-keyword list (JLS 3.9) are
// language-specification constants, not a service's current catalog. Adding a keyword to Java is a
// language-version event; adding a starter to Initializr happens continuously.
import { SLUG_RE } from '../lib/featureid.mjs';

// JLS 3.9, complete: the 50 classic reserved keywords plus `_` (a keyword since Java 9) -- 51 in
// the current JLS 3.9 list -- plus the three
// reserved literals (`true`/`false`/`null` -- not keywords per the spec, but equally illegal as an
// identifier, which is the only property this validator cares about). Deliberately does NOT include
// contextual keywords (`var`, `record`, `yield`, `sealed`, `permits`, `module`, ...) -- those remain
// legal identifiers in general contexts, and rejecting them would be over-validation.
export const JAVA_RESERVED_WORDS = new Set([
	'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
	'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
	'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
	'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
	'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
	'volatile', 'while', '_',
	'true', 'false', 'null',
]);

// ASCII only, on purpose. The Java language itself accepts any `Character.isJavaIdentifierStart`
// codepoint (so `com.café` really is a legal package name), but this is a scaffolder writing a
// directory tree that has to survive whatever filesystem, zip extractor and CI runner the project
// later lands on -- and Initializr accepts a non-ASCII groupId with HTTP 200 either way, so nothing
// upstream is checking it. Narrower than the language, deliberately, and documented as such.
const JAVA_IDENTIFIER_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A control character or a newline in a value that gets written into a TOML/Python/Gradle string
// literal breaks the generated file rather than the request -- rejected before anything is written.
function hasControlCharacters(value) {
	for (const ch of value) {
		const code = ch.codePointAt(0);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

export function requireSingleLineText(value, flag) {
	if (typeof value !== 'string') throw new Error(`--${flag} must be a string`);
	if (hasControlCharacters(value)) {
		throw new Error(`invalid --${flag} -- must not contain newlines or control characters (it is written verbatim into a generated file)`);
	}
	return value;
}

// Shared by --group-id and --package-name: same grammar, so one validator, per this project's own
// "one implementation, two call sites" habit (lib/template.mjs, scanners/text-util.mjs).
export function requireValidJavaPackageName(value, flag) {
	if (typeof value !== 'string' || value === '') {
		throw new Error(`invalid --${flag} "${value}" -- expected a dot-separated Java package name (e.g. com.example)`);
	}
	const segments = value.split('.');
	for (const segment of segments) {
		if (segment === '') {
			throw new Error(`invalid --${flag} "${value}" -- empty package segment (a leading, trailing or doubled ".")`);
		}
		if (!JAVA_IDENTIFIER_SEGMENT_RE.test(segment)) {
			throw new Error(`invalid --${flag} "${value}" -- segment "${segment}" is not a Java identifier (ASCII letters, digits and "_", never starting with a digit). start.spring.io accepts this with HTTP 200 and generates a project that will not compile, so it is checked here.`);
		}
		if (JAVA_RESERVED_WORDS.has(segment)) {
			throw new Error(`invalid --${flag} "${value}" -- segment "${segment}" is a Java reserved word (JLS 3.9) and cannot be a package segment. start.spring.io accepts this with HTTP 200 and generates a project that will not compile, so it is checked here.`);
		}
	}
	return value;
}

// Reuses lib/featureid.mjs's own SLUG_RE -- the exact validator `--slug` (whose value is what
// `--artifact-id` defaults to) already passes through, rather than a second, subtly different
// artifact-id grammar.
export function requireValidArtifactId(value) {
	if (typeof value !== 'string' || !SLUG_RE.test(value)) {
		throw new Error(`invalid --artifact-id "${value}" -- expected lowercase-hyphenated words (e.g. my-service), the same shape --slug accepts`);
	}
	return value;
}

// ★ Found live, not reasoned about: the first working `bskel new --stack fastapi --name "Demo
// Service"` run produced a pyproject.toml with `name = "Demo Service"`, which is valid TOML and an
// INVALID project name -- `pip install -e .` rejects it outright. Unlike Spring, where Initializr
// sanitizes `name` into a main-class identifier on its own, nothing downstream of this tool checks
// a FastAPI project name at all. Same category as the Java package validator above: a fixed grammar
// from a published specification (PEP 508 / the PyPA name spec, reproduced verbatim below), so a
// local check here does not go stale the way a copy of a service's current catalog would.
//
// Consequence, documented rather than worked around: `--name` sets BOTH pyproject.toml's `name` and
// FastAPI's `title=`, so a prose title with spaces is rejected. Editing `app/main.py`'s one
// `FastAPI(title=...)` line afterwards is the escape hatch; splitting this into two flags would be
// inventing a distinction the user did not ask for.
const PYTHON_PROJECT_NAME_RE = /^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;

export function requireValidPythonProjectName(value) {
	if (typeof value !== 'string' || !PYTHON_PROJECT_NAME_RE.test(value)) {
		throw new Error(`invalid --name "${value}" -- must be a valid Python project name (PEP 508: ASCII letters, digits, ".", "-" and "_", starting and ending alphanumeric). It is written into pyproject.toml's [project] name, which pip validates -- a name with spaces produces a project that scaffolds fine and cannot be installed.`);
	}
	return value;
}

// `requires-python` is a PEP 440 version specifier. There is no live authority to check a Python
// version against the way start.spring.io's metadata is one for Java (python.org publishes no
// equivalent machine-readable "currently supported" document this tool could consult on demand),
// and the value is only ever substituted into pyproject.toml as a string -- so this validates that
// it is SYNTACTICALLY sane, never that the version exists.
//
// Accepted, deliberately narrow (one clause, no comma-joined specifier sets): a bare `3.12` /
// `3.12.1` (normalized to `>=3.12`), or an explicit single-operator floor (`>=3.12`, `>3.12`,
// `~=3.12`, `==3.12`). A bare upper bound (`<3.13`) is rejected because the flag is documented as a
// FLOOR -- silently accepting a specifier that says the opposite of what the flag is named would be
// the exact "the generated file encodes a claim the user did not state" failure this item's own
// safe/unsafe line rules out. A project needing a compound specifier edits one line of the
// generated pyproject.toml, which is a file it now owns outright.
const PYTHON_VERSION_RE = /^(>=|>|~=|==)?(\d+)\.(\d+)(?:\.(\d+))?$/;

// The shipped FastAPI template's own floor, not a claim about Python or FastAPI in general:
// new/templates/fastapi/app/main.py annotates `-> dict[str, str]`, a PEP 585 builtin generic that
// raises TypeError at runtime before 3.9, and FastAPI evaluates route return annotations.
export const FASTAPI_TEMPLATE_MIN_PYTHON = { major: 3, minor: 9 };

export function parsePythonVersion(value) {
	if (typeof value !== 'string') return null;
	const m = PYTHON_VERSION_RE.exec(value.trim());
	if (!m) return null;
	return {
		operator: m[1] ?? '>=',
		major: Number(m[2]),
		minor: Number(m[3]),
		patch: m[4] == null ? null : Number(m[4]),
		release: m[4] == null ? `${m[2]}.${m[3]}` : `${m[2]}.${m[3]}.${m[4]}`,
	};
}

// Returns `{ requiresPython, warnings }` -- the exact string to substitute into pyproject.toml's
// `requires-python`, plus any "this is legal but your generated code needs more" notes. Warns
// rather than refuses, matching --dependencies' own "warn loudly, then trust the user" register:
// a caller who intends to rewrite app/main.py is making a legitimate choice this tool should not
// veto.
export function requireValidPythonVersion(value) {
	const parsed = parsePythonVersion(value);
	if (!parsed) {
		throw new Error(`invalid --python-version "${value}" -- expected a bare version (3.12, 3.12.1) or a single-operator floor (>=3.12, >3.12, ~=3.12, ==3.12); a compound specifier or a bare upper bound is not accepted (this flag sets pyproject.toml's requires-python FLOOR)`);
	}
	const warnings = [];
	const belowTemplateFloor = parsed.major < FASTAPI_TEMPLATE_MIN_PYTHON.major
		|| (parsed.major === FASTAPI_TEMPLATE_MIN_PYTHON.major && parsed.minor < FASTAPI_TEMPLATE_MIN_PYTHON.minor);
	if (belowTemplateFloor) {
		warnings.push(`--python-version ${value} sets requires-python below ${FASTAPI_TEMPLATE_MIN_PYTHON.major}.${FASTAPI_TEMPLATE_MIN_PYTHON.minor}, which the generated app/main.py itself needs: its \`-> dict[str, str]\` return annotation is a PEP 585 builtin generic that raises TypeError at runtime on older interpreters, and FastAPI evaluates route return annotations. Scaffolding anyway -- rewrite app/main.py's annotations if you really mean to target ${parsed.release}.`);
	}
	return { requiresPython: `${parsed.operator}${parsed.release}`, warnings };
}

// An SPDX identifier or short expression. Deliberately NOT checked against a bundled copy of the
// SPDX license list: that list is external truth that changes, and a stale local copy of external
// truth is the exact thing this project refuses everywhere else (D-greenfield-bootstrap's rejected
// `.bskel/config.yml`, `runScan()`'s fresh-every-run adapter detection). Unlike --java-version there
// is no cheap on-demand authority to consult either, so this validates SHAPE only -- enough to keep
// the value from breaking the TOML string it lands in.
const LICENSE_RE = /^[A-Za-z0-9][A-Za-z0-9.+ ()-]*$/;

export function requireValidLicense(value) {
	if (typeof value !== 'string' || !LICENSE_RE.test(value)) {
		throw new Error(`invalid --license "${value}" -- expected an SPDX identifier or short expression (e.g. MIT, Apache-2.0, "MIT OR Apache-2.0"). Not checked against the real SPDX list -- this tool keeps no local copy of external truth.`);
	}
	return value;
}

export const DATABASE_CHOICES = Object.freeze(['postgres', 'sqlite', 'none']);

export function requireValidDatabase(value) {
	if (!DATABASE_CHOICES.includes(value)) {
		throw new Error(`invalid --database "${value}" -- expected one of: ${DATABASE_CHOICES.join(', ')}`);
	}
	return value;
}

// ---- --java-version: on-demand live metadata, never cached, never persisted ----------------
//
// start.spring.io/metadata/client is the same document the start.spring.io web UI populates its own
// dropdowns from. Fetched ONLY when a non-default --java-version is actually passed (a user who
// doesn't ask pays no extra network call), and never written to disk -- consistent with
// D-greenfield-bootstrap's refusal to persist a `.bskel/config.yml`, and with the whole project's
// position that a local copy of a moving external fact is worse than no copy.
export const INITIALIZR_METADATA_URL = 'https://start.spring.io/metadata/client';

// Measured 2026-08-23: `javaVersion` is `{type, default, values: [{id, name}, ...]}` with ids
// ["26","25","21","17"] and default "17". Parsed defensively anyway -- a shape change upstream must
// produce a clean, actionable message here, not a TypeError.
export async function fetchSupportedJavaVersions({ fetchImpl = globalThis.fetch } = {}) {
	let response;
	try {
		response = await fetchImpl(INITIALIZR_METADATA_URL, { headers: { Accept: 'application/json' } });
	} catch (err) {
		throw new Error(`could not reach start.spring.io to validate --java-version (${err.message}) -- check network access, or omit --java-version to use this tool's own default`);
	}
	if (!response.ok) {
		throw new Error(`start.spring.io returned ${response.status} ${response.statusText} for its own version metadata -- the request was: ${INITIALIZR_METADATA_URL}`);
	}
	let body;
	try {
		body = await response.json();
	} catch (err) {
		throw new Error(`start.spring.io's version metadata was not readable JSON (${err.message}) -- the request was: ${INITIALIZR_METADATA_URL}`);
	}
	const values = body?.javaVersion?.values;
	const ids = Array.isArray(values) ? values.map((v) => v?.id).filter((id) => typeof id === 'string' && id !== '') : [];
	if (ids.length === 0) {
		throw new Error(`start.spring.io's version metadata carried no javaVersion.values list -- cannot validate --java-version against it. The request was: ${INITIALIZR_METADATA_URL}`);
	}
	return ids;
}

export async function requireSupportedJavaVersion(javaVersion, opts = {}) {
	if (typeof javaVersion !== 'string' || javaVersion === '') {
		throw new Error(`invalid --java-version "${javaVersion}" -- expected a version id start.spring.io offers (e.g. 17, 21, 25)`);
	}
	const supported = await fetchSupportedJavaVersions(opts);
	if (!supported.includes(javaVersion)) {
		throw new Error(`--java-version ${javaVersion} is not one start.spring.io currently offers (it offers: ${supported.join(', ')}). This is checked here because start.spring.io accepts an unknown javaVersion with HTTP 200 and writes it straight into build.gradle as JavaLanguageVersion.of(${javaVersion}) -- a project that downloads fine and never compiles.`);
	}
	return javaVersion;
}
