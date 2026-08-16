// G1: zero-registration adapter discovery -- mirrors stack/apply.mjs's listCatalogChoices()/
// loadCatalogEntry() (D7 in DECISIONS.md), with one unavoidable difference: a stack catalog entry
// is pure YAML data, but a scanner adapter is CODE -- dropping a file here executes it. That is
// acceptable because scanners/adapters/ lives inside this skill's own source, at the same trust
// level as the rest of it.
//
// SECURITY: `loadAdapters({adaptersDir})` below is a test seam ONLY. Never wire it to a CLI flag
// or an environment variable -- doing so would turn "which directory of JS gets executed" into
// user-controllable input. See D-adapter-registry in DECISIONS.md.
//
// SYNC: `runScan()`/`cmdScan()`/`main()` in bin/bskel.mjs are all synchronous, and existing tests
// (test/scan.test.mjs, test/contract.test.mjs) call `runScan` synchronously. `import()` is
// inherently async, so adapter loading happens via a top-level await here instead of forcing
// every caller of `runScan` to become async. `scanners/index.mjs` statically imports the
// constants exported below -- Node resolves this module's top-level await as part of resolving
// that static import, before any of index.mjs's own top-level code runs, so `runScan` itself
// stays fully synchronous. No cycle risk: this module imports nothing from scanners/index.mjs,
// and no adapter imports anything from this module.
//
// BUNDLER CAVEAT: dynamic `import()` over a `readdirSync` result is invisible to bundlers. There
// is no build step in this project today (bin/bskel.mjs runs straight from source, no `build`
// script in package.json), so this costs nothing now -- but adding esbuild/ncc/etc. later would
// silently produce a zero-adapter registry. Worth remembering if a build step is ever added.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const REGISTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = path.join(REGISTRY_DIR, 'adapters');
const SCHEMAS_ROOT = path.join(REGISTRY_DIR, '..', 'schemas');
const SUPPORTED_CONTRACT = 'sbf.adapter/1';

let _ajv = null;
function ajv() {
	if (!_ajv) _ajv = new Ajv2020({ allErrors: true, strict: false });
	return _ajv;
}

function loadAdapterSchema() {
	return JSON.parse(fs.readFileSync(path.join(SCHEMAS_ROOT, 'adapter.schema.json'), 'utf8'));
}

// O6-style determinism: readdirSync has no cross-platform ordering guarantee either -- `.sort()`
// on the filename list, same discipline as scanners/adapters/*.mjs's own `rg --files` fix.
//
// Filtered by NAME, not `withFileTypes()` + `isFile()` -- `isFile()` is false for a symlink, and
// this skill is itself symlinked into `~/.claude/skills` (see D0 in DECISIONS.md), so a
// symlinked adapter file is a plausible real shape, not a hypothetical. `_`/`.`-prefixed files
// are the shared-helper convention (mirrors stack/apply.mjs's own catalog dir filtering) and are
// silently skipped, not treated as malformed adapters.
function candidateFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((name) => name.endsWith('.mjs') && !name.startsWith('_') && !name.startsWith('.'))
		.sort()
		.map((name) => path.join(dir, name));
}

async function loadOneAdapter(file, schema) {
	const id = path.basename(file, '.mjs');
	let mod;
	try {
		mod = await import(pathToFileURL(file).href);
	} catch (err) {
		return { error: { file, message: `failed to load: ${err.message}` } };
	}
	const descriptor = mod.adapter;
	if (!descriptor || typeof descriptor !== 'object') {
		return { error: { file, message: 'must `export const adapter = {...}` (sbf.adapter/1 shape) -- no such export found' } };
	}
	if (descriptor.contract !== SUPPORTED_CONTRACT) {
		return { error: { file, message: `declares contract "${descriptor.contract}" -- this build only understands "${SUPPORTED_CONTRACT}"` } };
	}
	if (descriptor.id !== id) {
		return { error: { file, message: `adapter.id "${descriptor.id}" must equal its filename "${id}"` } };
	}

	// Validate only the JSON-shaped fields -- detect/scan/diagnostics are functions, which JSON
	// Schema has no vocabulary for; checked separately below.
	const { detect, scan, diagnostics, ...data } = descriptor;
	const validateFn = ajv().getSchema(schema.$id) ?? ajv().compile(schema);
	if (!validateFn(data)) {
		const details = (validateFn.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
		return { error: { file, message: `does not match schemas/adapter.schema.json: ${details}` } };
	}
	for (const fnName of ['detect', 'scan']) {
		if (typeof descriptor[fnName] !== 'function') {
			return { error: { file, message: `adapter.${fnName} must be a function` } };
		}
	}
	if (descriptor.diagnostics !== undefined && typeof descriptor.diagnostics !== 'function') {
		return { error: { file, message: 'adapter.diagnostics, if present, must be a function' } };
	}
	return { adapter: descriptor };
}

// Exported for the registry's own unit tests and for `bskel doctor`'s LOAD_ERRORS listing. A
// broken adapter file must not brick every `bskel` command (this module is imported at process
// start, before `main()` even parses argv) -- so loading is per-file try/catch: the adapters that
// did load are still usable, and every failure is collected, never silently dropped.
export async function loadAdapters({ adaptersDir = ADAPTERS_DIR } = {}) {
	const schema = loadAdapterSchema();
	const adapters = [];
	const errors = [];
	for (const file of candidateFiles(adaptersDir)) {
		const result = await loadOneAdapter(file, schema);
		if (result.error) errors.push(result.error);
		else adapters.push(result.adapter);
	}
	// Arbitration order for scanners/index.mjs's dispatch loop: higher specificity first, id as a
	// stable tiebreak. This is a display/iteration convenience only -- genuine ambiguity (two
	// adapters at the SAME specificity both detecting the same repo) is caught at dispatch time in
	// runScan(), not here, since detect() needs a real repoRoot to evaluate.
	adapters.sort((a, b) => b.specificity - a.specificity || a.id.localeCompare(b.id));
	return { adapters, errors };
}

export function adapterById(adapters, id) {
	return adapters.find((a) => a.id === id) ?? null;
}

// Top-level await: see the SYNC note in the module header.
export const { adapters: ADAPTERS, errors: LOAD_ERRORS } = await loadAdapters();
