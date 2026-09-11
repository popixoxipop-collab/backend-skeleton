// D3 (D-scanner-evidence): extracted from python-fastapi.mjs/generic-grep.mjs, which each had
// their own copy of this exact function -- java-spring.mjs needs the same thing now that D3
// requires every adapter to track a line number per evidence-bearing match, not just endpoints.
export function lineNumberAt(text, index) {
	let line = 1;
	for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
	return line;
}

// D-cross-adapter-root-detection: same extraction pattern as lineNumberAt above, one adapter
// generation later -- python-fastapi.mjs and scanners/adapters/_express-shared.mjs (shared by
// typescript-express.mjs/javascript-express.mjs) each already had their own private copy of both
// functions before java-spring.mjs needed them too. `excludeGlobs` is a parameter, not baked in,
// because the two existing copies actually disagreed on it (Python's excludes .venv/site-packages/
// __pycache__; the Express one excludes dist/build) -- inlining either would have been wrong for
// the other caller.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function listRgFiles(dir, globs, excludeGlobs = []) {
	try {
		const out = execFileSync('rg', ['--files', ...globs.flatMap((g) => ['-g', g]), ...excludeGlobs.flatMap((g) => ['-g', g]), dir], { encoding: 'utf8' });
		return out.split('\n').filter(Boolean).sort(); // O6: rg --files order isn't guaranteed.
	} catch {
		return []; // rg exits 1 on "no files matched" -- not an error, just nothing to report
	}
}

export function byShallowestThenName(a, b) {
	const depthA = a.split(path.sep).length;
	const depthB = b.split(path.sep).length;
	return depthA !== depthB ? depthA - depthB : a.localeCompare(b);
}

// D-zero-config-scan: the pure "is this binary on PATH" check, deliberately living HERE (a
// leaf module with zero project-internal imports) rather than in lib/doctor.mjs, where it was
// first written. lib/doctor.mjs imports lib/verify.mjs, which imports scanners/registry.mjs --
// and every adapter file is dynamically import()ed BY registry.mjs's own top-level await. An
// adapter importing lib/doctor.mjs would close that cycle (adapter -> lib/doctor.mjs ->
// lib/verify.mjs -> scanners/registry.mjs -> [import()s the adapter]) and registry.mjs's OWN
// header comment already flags exactly this risk ("no adapter imports anything from this
// module" -- true of registry.mjs itself, but lib/doctor.mjs transitively reaches it). Found
// live: the first version of this change put binaryAvailable() in lib/doctor.mjs and every
// adapter import of it hung the whole CLI (a real "Detected unsettled top-level await" Node
// warning, reproduced against a real fixture repo, not a hypothetical). lib/doctor.mjs now
// re-exports this for its own existing callers (bin/bskel.mjs, its own binaryCheck()) --
// nothing outside this file needs to know it moved.
export function binaryAvailable(name, execFn = execFileSync) {
	try {
		execFn(name, ['--version'], { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}
