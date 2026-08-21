// P2 (D-greenfield-bootstrap): the only `bskel` command that talks to a network service --
// Spring Initializr's own public `start.spring.io` REST API (the same one behind `spring init`/
// the start.spring.io web UI). Every other command in this tool is pure local git/fs, so this is
// a genuinely new risk category: never auto-triggered by any other command, always a single
// explicit invocation, and `--offline` refuses cleanly instead of hanging on a dead connection.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// "Pinned" means the DEPENDENCY SET is a named, reviewable constant here, not a live query
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
const DEPENDENCIES = ['web', 'data-jpa', 'security', 'validation', 'lombok'];
const JAVA_VERSION = '17';
const INITIALIZR_URL = 'https://start.spring.io/starter.zip';

const GROUP_ID = 'com.example';

// Java package names can't contain hyphens -- `demo-app` becomes `demoapp`, matching the
// convention `handles/providers/java-spring/plan.mjs::detectBasePackage()` itself would derive
// from the resulting *Application.java's own package declaration.
export function buildInitializrUrl({ slug }) {
	const packageSuffix = slug.replace(/-/g, '');
	const params = new URLSearchParams({
		type: 'gradle-project',
		language: 'java',
		javaVersion: JAVA_VERSION,
		groupId: GROUP_ID,
		artifactId: slug,
		name: slug,
		packageName: `${GROUP_ID}.${packageSuffix}`,
		dependencies: DEPENDENCIES.join(','),
	});
	return `${INITIALIZR_URL}?${params.toString()}`;
}

// `--offline` (or no network at all) must fail with a clear, actionable message -- never hang or
// produce a raw fetch stack trace. Mirrors `bskel preflight --offline`'s own precedent for the
// no-network case.
export async function scaffoldSpring({ dir, slug, offline = false }) {
	if (offline) {
		throw new Error('bskel new --stack spring requires network access (calls start.spring.io) -- re-run without --offline, or use --stack fastapi (fully local, no network call)');
	}
	if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
		throw new Error(`${dir} already exists and is not empty -- refusing to scaffold into it`);
	}

	const url = buildInitializrUrl({ slug });
	let response;
	try {
		response = await fetch(url);
	} catch (err) {
		throw new Error(`could not reach start.spring.io (${err.message}) -- check network access, or use --stack fastapi (fully local, no network call)`);
	}
	if (!response.ok) {
		throw new Error(`start.spring.io returned ${response.status} ${response.statusText} -- the request was: ${url}`);
	}
	const zipBytes = Buffer.from(await response.arrayBuffer());

	fs.mkdirSync(dir, { recursive: true });
	const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-spring-')), `${slug}.zip`);
	fs.writeFileSync(zipPath, zipBytes);
	try {
		execFileSync('unzip', ['-q', zipPath, '-d', dir]);
	} catch (err) {
		throw new Error(`could not extract the downloaded project (is \`unzip\` on PATH?): ${err.message}`);
	} finally {
		fs.rmSync(path.dirname(zipPath), { recursive: true, force: true });
	}

	return { dir, dependencies: DEPENDENCIES, javaVersion: JAVA_VERSION };
}
