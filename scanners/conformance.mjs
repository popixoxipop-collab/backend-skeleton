import assert from 'node:assert/strict';

// P4 (D-extension-conformance): a reusable conformance check for a scanner adapter -- usable by a
// third-party adapter author, not just this project's own 3 shipped adapters, before shipping
// one. Checks the behavioral contract scanners/registry.mjs's schema validation can't (detect/
// scan are functions, JSON Schema has no vocabulary for them): detect() doesn't throw, a truthy
// detect() is followed by a scan() whose shape matches what scanners/index.mjs::runScan() actually
// consumes (`result.modules`, each module carrying `module`/`controllers`/`entities`/`enums`),
// and -- never machine-verified anywhere in this codebase before this -- that scan() is actually
// deterministic: two consecutive calls against the same repoRoot return deep-equal results, the
// exact property every shipped adapter's own `.sort()` calls exist to guarantee (O6), previously
// only a code-review-level belief, not a checked one.
export function checkAdapterConformance(adapter, repoRoot) {
	const errors = [];
	let detection;
	try {
		detection = adapter.detect(repoRoot);
	} catch (err) {
		errors.push(`detect() threw: ${err.message}`);
		return { adapter: adapter.id, ok: false, errors };
	}
	if (detection == null) {
		// A falsy detect() means this adapter doesn't claim this repoRoot -- nothing further to
		// check (mirrors runScan()'s own `.filter(({ d }) => d != null)`).
		return { adapter: adapter.id, ok: true, errors: [] };
	}

	let first;
	try {
		first = adapter.scan(repoRoot, detection);
	} catch (err) {
		errors.push(`scan() threw: ${err.message}`);
		return { adapter: adapter.id, ok: false, errors };
	}
	if (!first || !Array.isArray(first.modules)) {
		errors.push('scan() must return { modules: Array } -- runScan() reads result.modules directly');
		return { adapter: adapter.id, ok: false, errors };
	}
	for (const mod of first.modules) {
		for (const field of ['module', 'controllers', 'entities', 'enums']) {
			if (!(field in mod)) errors.push(`scan() module ${JSON.stringify(mod.module ?? '(unknown)')} is missing required field "${field}"`);
		}
	}

	let second;
	try {
		second = adapter.scan(repoRoot, detection);
	} catch (err) {
		errors.push(`scan() threw on its second, back-to-back call: ${err.message}`);
		return { adapter: adapter.id, ok: false, errors };
	}
	try {
		assert.deepStrictEqual(second, first);
	} catch {
		errors.push('scan() is not deterministic -- two consecutive calls against the same repoRoot returned different results (check for an un-sorted directory listing or Set/Map iteration order)');
	}

	return { adapter: adapter.id, ok: errors.length === 0, errors };
}
