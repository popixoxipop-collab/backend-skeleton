// Shared by every scripts/*-smoke.mjs CI script -- extracted after a real incident (2026-08-31):
// the cross-feature-collision item added a new hard prerequisite to `handles emit`
// (D-cross-feature-collision) and the fix was applied to all ~15 `node --test` files but missed
// all 5 of these CI-only smoke scripts, because `npm test`'s own glob (`node --test test/*.test.
// mjs`) never covers `scripts/`. Main's CI was red on every push for hours before anyone noticed --
// see D-cross-feature-collision's own update note in DECISIONS.md. This module exists so the NEXT
// new mandatory pre-`handles emit` gate is a one-place fix (`establishThroughContract` below), not
// a five-script hunt again. `bskel()`/`fail()` were also byte-for-byte duplicated across all 5
// scripts before this -- pure code motion, no behavior change to either.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '..');
export const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');

export function bskel(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

export function makeFail(scriptName) {
	return function fail(message) {
		console.error(`${scriptName}: FAIL -- ${message}`);
		process.exit(1);
	};
}

// The full preflight -> feature init -> scan -> disposition -> contract-established -> cross-
// feature-check sequence every smoke script needs before it can call `handles emit` for real.
// `contractStep` is either `{kind: 'emit', args: [...]}` (extra args appended after `--feature
// <id>` to a real `contract emit`) or `{kind: 'force', reason: '...'}` (`gate force contract`, for
// the ecosystems with no real OpenAPI oracle to emit from). `fail` is each script's own
// `makeFail()`-built reporter, so a failure here reads exactly like a failure the script's own
// inline code would have reported -- this function changes WHERE the sequence lives, not how a
// caller experiences a failure in it.
// `beforeContractStep` (optional) runs AFTER preflight but BEFORE the contract step -- some
// callers (python-import-smoke.mjs) need to write a fixture file (an openapi.json) that must NOT
// exist yet when `preflight` runs its own dirty-tree check, but does need to exist before
// `contract emit` reads it. Getting this ordering wrong is exactly the kind of thing that only
// shows up by actually running the script, not by reading the diff -- found live refactoring this
// module in, not assumed correct from the start.
export function establishThroughContract(scratch, fail, { featureId, slug, terms, mode, note, contractStep, beforeContractStep }) {
	let r = bskel(['preflight'], scratch);
	if (r.code !== 0) fail(`preflight: ${r.stderr || r.stdout}`);

	r = bskel(['feature', 'init', '--slug', slug], scratch);
	if (r.code !== 0) fail(`feature init: ${r.stderr || r.stdout}`);

	r = bskel(['scan', '--feature', featureId, '--terms', terms], scratch);
	if (![0, 3].includes(r.code)) fail(`scan: exit ${r.code}: ${r.stderr || r.stdout}`);

	r = bskel(['scan', 'disposition', '--feature', featureId, '--mode', mode, '--note', note], scratch);
	if (r.code !== 0) fail(`scan disposition: ${r.stderr || r.stdout}`);

	if (beforeContractStep) beforeContractStep();

	if (contractStep.kind === 'emit') {
		r = bskel(['contract', 'emit', '--feature', featureId, ...contractStep.args], scratch);
		if (r.code !== 0) fail(`contract emit: ${r.stderr || r.stdout}`);
	} else {
		r = bskel(['gate', 'force', 'contract', '--feature', featureId, '--reason', contractStep.reason], scratch);
		if (r.code !== 0) fail(`gate force contract: ${r.stderr || r.stdout}`);
	}

	// D-cross-feature-collision: the exact step this whole module exists to keep in ONE place.
	r = bskel(['scan', 'cross-feature-check', '--feature', featureId], scratch);
	if (r.code !== 0) fail(`scan cross-feature-check: ${r.stderr || r.stdout}`);
}
