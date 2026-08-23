// P2 (D-greenfield-bootstrap): the only `bskel` command that talks to a network service --
// Spring Initializr's own public `start.spring.io` REST API (the same one behind `spring init`/
// the start.spring.io web UI). Every other command in this tool is pure local git/fs, so this is
// a genuinely new risk category: never auto-triggered by any other command, always a single
// explicit invocation, and `--offline` refuses cleanly instead of hanging on a dead connection.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// "Pinned" means the DEFAULT DEPENDENCY SET is a named, reviewable constant here, not a live query
// against whatever Initializr's own current defaults happen to be today -- the same dependency
// set test/fixtures/java-compile/build.gradle and the real oracle repo both already use
// (web, data-jpa, security, validation, lombok), so a freshly scaffolded project is immediately
// compatible with every other `bskel` command (handles codegen, contract emit's Bean Validation
// assumptions, etc.) with zero extra setup. `javaVersion` matches this whole tool's established
// Java 17 baseline (CLAUDE.md's own documented oracle-repo toolchain). Deliberately does NOT pin
// an exact `bootVersion` -- Spring Initializr only serves actively-supported versions and ages
// old ones out on its own schedule, so a hardcoded exact version is a maintenance liability here
// (unlike a gate token, where rigidity is the safety property); this tool's own Jackson-package
// detection (handles/providers/java-spring/emit.mjs's detectJacksonPackage) already adapts to
// whichever major version Initializr hands back, Boot 3 or 4.
//
// P2b (D-greenfield-parameters): these are now DEFAULTS a caller can override, not hardcodes. The
// pinning argument above survives intact -- what it was ever protecting is "bskel does not silently
// track Initializr's moving defaults", not "a user may not state their own group id".
export const BASE_DEPENDENCIES = Object.freeze(['web', 'data-jpa', 'security', 'validation', 'lombok']);
export const DEFAULT_JAVA_VERSION = '17';
export const DEFAULT_GROUP_ID = 'com.example';

const INITIALIZR_URL = 'https://start.spring.io/starter.zip';

// P2b: the three baseline dependencies OTHER `bskel` commands actually require downstream. Dropping
// `security` or `lombok` degrades nothing bskel itself does, so neither is warned about.
const REQUIRED_FOR_BSKEL = Object.freeze({
	web: 'without `web` the project has no @RestController/@RequestMapping endpoints at all, so `bskel scan`\'s java-spring adapter finds no controllers and `bskel contract emit` has nothing to build operations from',
	'data-jpa': 'without `data-jpa` the project has no @Entity classes, so the java-spring adapter reports zero resources and `bskel handles plan` approves nothing (resource.fetch has nothing to fetch)',
	validation: 'without `validation` the resolver `bskel handles emit` generates will not compile -- its patchField() imports jakarta.validation.Validator / ConstraintViolation (see D-patch-strategy)',
});

function splitDependencyList(raw, flag) {
	const ids = String(raw).split(',').map((s) => s.trim()).filter((s) => s !== '');
	if (ids.length === 0) {
		throw new Error(`--${flag} was given no usable dependency ids (got ${JSON.stringify(raw)}) -- pass a comma-separated list of start.spring.io dependency ids, e.g. --${flag} actuator,postgresql`);
	}
	return [...new Set(ids)];
}

// P2b (D-greenfield-parameters), user decision: `--dependencies` REPLACES the baseline five rather
// than adding to them. That is deliberately the more dangerous of the two semantics -- so the danger
// is made VISIBLE (a specific, named warning per missing baseline dependency, naming what breaks)
// rather than prevented. `--add-dependencies` is the additive-only flag for the common case; it
// cannot drop anything, so it never warns. Mutually exclusive -- merging their semantics would make
// "did I replace or extend?" un-answerable from the command line alone.
//
// Pure: returns the resolved set plus the warnings, so the caller decides where they go (stderr,
// per this CLI's own contract that warnings are never suppressed by --quiet or --json).
export function resolveSpringDependencies({ dependencies = null, addDependencies = null } = {}) {
	if (dependencies != null && addDependencies != null) {
		throw new Error('--dependencies and --add-dependencies are mutually exclusive -- --dependencies REPLACES the baseline set (web, data-jpa, security, validation, lombok), --add-dependencies extends it');
	}

	let resolved;
	if (dependencies != null) {
		resolved = splitDependencyList(dependencies, 'dependencies');
	} else if (addDependencies != null) {
		resolved = [...new Set([...BASE_DEPENDENCIES, ...splitDependencyList(addDependencies, 'add-dependencies')])];
	} else {
		resolved = [...BASE_DEPENDENCIES];
	}

	const warnings = [];
	for (const [id, consequence] of Object.entries(REQUIRED_FOR_BSKEL)) {
		if (resolved.includes(id)) continue;
		warnings.push(`warning: the requested dependency set does not include \`${id}\` -- ${consequence}. Scaffolding anyway (you asked for this set explicitly); add it with \`--add-dependencies ${id}\` if that was not intended.`);
	}
	return { dependencies: resolved, warnings };
}

// Java package names can't contain hyphens -- `demo-app` becomes `demoapp`, matching the
// convention `handles/providers/java-spring/plan.mjs::detectBasePackage()` itself would derive
// from the resulting *Application.java's own package declaration.
//
// P2b: every parameter below is optional and defaults to exactly what P2 hardcoded, so calling this
// with only `{ slug }` produces a BYTE-IDENTICAL url to the pre-P2b one -- including query-parameter
// ORDER, which is why the four optional keys are appended after the original eight rather than
// interleaved. `test/new-cli.test.mjs` pins that string exactly.
export function buildInitializrUrl({
	slug,
	groupId = DEFAULT_GROUP_ID,
	artifactId = null,
	packageName = null,
	name = null,
	description = null,
	projectVersion = null,
	javaVersion = DEFAULT_JAVA_VERSION,
	packaging = null,
	dependencies = BASE_DEPENDENCIES,
} = {}) {
	const packageSuffix = slug.replace(/-/g, '');
	const params = new URLSearchParams({
		type: 'gradle-project',
		language: 'java',
		javaVersion,
		groupId,
		artifactId: artifactId ?? slug,
		name: name ?? slug,
		packageName: packageName ?? `${groupId}.${packageSuffix}`,
		dependencies: [...dependencies].join(','),
	});
	// Never sent unless explicitly asked for: an omitted parameter lets Initializr apply its own
	// current default, which is the same reason `bootVersion` is never sent at all.
	if (packaging != null) params.set('packaging', packaging);
	if (description != null) params.set('description', description);
	if (projectVersion != null) params.set('version', projectVersion);
	return `${INITIALIZR_URL}?${params.toString()}`;
}

// Initializr answers a bad `dependencies`/`type`/`packaging`/`language` with a clean, quotable JSON
// body: {"timestamp":...,"status":400,"error":"Bad Request","message":"Unknown dependency
// 'not-a-real-dep' check project metadata","path":"/starter.zip"} (measured 2026-08-23). Surfacing
// that `message` verbatim is what makes pass-through validation an honest choice for those four
// parameters instead of a shrug. Defensive on every step: a mocked/odd response object without
// .json() must not turn a clean HTTP error into a TypeError.
async function describeHttpFailure(response) {
	if (typeof response.json !== 'function') return null;
	try {
		const body = await response.json();
		const message = body?.message;
		return typeof message === 'string' && message !== '' ? message : null;
	} catch {
		return null;
	}
}

// `--offline` (or no network at all) must fail with a clear, actionable message -- never hang or
// produce a raw fetch stack trace. Mirrors `bskel preflight --offline`'s own precedent for the
// no-network case.
export async function scaffoldSpring({
	dir,
	slug,
	offline = false,
	groupId = DEFAULT_GROUP_ID,
	artifactId = null,
	packageName = null,
	name = null,
	description = null,
	projectVersion = null,
	javaVersion = DEFAULT_JAVA_VERSION,
	packaging = null,
	dependencies = BASE_DEPENDENCIES,
}) {
	if (offline) {
		throw new Error('bskel new --stack spring requires network access (calls start.spring.io) -- re-run without --offline, or use --stack fastapi (fully local, no network call)');
	}
	if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
		throw new Error(`${dir} already exists and is not empty -- refusing to scaffold into it`);
	}

	const url = buildInitializrUrl({ slug, groupId, artifactId, packageName, name, description, projectVersion, javaVersion, packaging, dependencies });
	let response;
	try {
		response = await fetch(url);
	} catch (err) {
		throw new Error(`could not reach start.spring.io (${err.message}) -- check network access, or use --stack fastapi (fully local, no network call)`);
	}
	if (!response.ok) {
		const detail = await describeHttpFailure(response);
		throw new Error(`start.spring.io returned ${response.status} ${response.statusText}${detail ? ` -- it said: ${detail}` : ''} -- the request was: ${url}`);
	}
	const zipBytes = Buffer.from(await response.arrayBuffer());

	fs.mkdirSync(dir, { recursive: true });
	const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-spring-')), `${slug}.zip`);
	fs.writeFileSync(zipPath, zipBytes);
	try {
		// P2b: `baseDir` is deliberately NEVER sent to Initializr and is deliberately NOT exposed as
		// a flag. With no baseDir the archive is FLAT (build.gradle/settings.gradle/src/gradlew at the
		// root), which is exactly what this extraction assumes -- setting it would nest the whole
		// project one level down and silently break every downstream adapter's detect(), which look
		// for `build.gradle` + `src/main/java` at the repo root. Pinned by a regression test.
		execFileSync('unzip', ['-q', zipPath, '-d', dir]);
	} catch (err) {
		throw new Error(`could not extract the downloaded project (is \`unzip\` on PATH?): ${err.message}`);
	} finally {
		fs.rmSync(path.dirname(zipPath), { recursive: true, force: true });
	}

	return {
		dir,
		dependencies: [...dependencies],
		javaVersion,
		groupId,
		artifactId: artifactId ?? slug,
		packageName: packageName ?? `${groupId}.${slug.replace(/-/g, '')}`,
		packaging,
	};
}
