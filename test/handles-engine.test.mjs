// D-write-safety-phase0 (item 3): direct unit test for handles/_engine.mjs's crash-safety --
// real fs, no CLI/git fixture needed (this scenario never reaches the --force/isDirtyOrUntracked
// path, which is the only thing in emitUnits() that shells out to git). Everything else in this
// codebase tests emitUnits() only indirectly, through a provider's emit() via the CLI -- this file
// exercises it directly because the property under test (manifest state after a mid-loop crash)
// isn't observable at the CLI layer at all: a real process crash can't be triggered from a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitUnits } from '../handles/_engine.mjs';
import { loadManifest, manifestPath } from '../lib/handles-manifest.mjs';

function buildTempRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-engine-crash-'));
	return root;
}

function makeResolverUnit(root, name, { throwOnRender = false } = {}) {
	const templatePath = path.join(root, `${name}.tmpl`);
	fs.writeFileSync(templatePath, `-- template for ${name}\n`);
	const targetAbs = path.join(root, 'out', `${name}.txt`);
	const content = `-- generated content for ${name}\n`;
	const unit = {
		id: `${name}.tmpl`,
		resourceType: name,
		module: 'crashtest',
		templatePath,
		targetAbs,
		pristineRenderFor: () => content,
	};
	if (throwOnRender) {
		// A getter fires on FIRST property access -- sha256String(u.rendered) inside emitUnits()'s
		// resolver loop is that first access, so this throws exactly where a real crash mid-write
		// would leave off: after every EARLIER unit in resolverUnits has already been fully
		// written and saved, before this one's own write ever starts.
		Object.defineProperty(unit, 'rendered', { get() { throw new Error(`simulated crash rendering ${name}`); } });
	} else {
		unit.rendered = content;
	}
	return unit;
}

test('a crash partway through the resolver loop leaves the manifest accurately reflecting only the units actually written, not the whole run', () => {
	const root = buildTempRepo();
	const unitA = makeResolverUnit(root, 'AlphaResolver');
	const unitB = makeResolverUnit(root, 'BetaResolver');
	const unitC = makeResolverUnit(root, 'GammaResolver', { throwOnRender: true });

	assert.throws(
		() => emitUnits({ repoRoot: root, featureId: '001-crash-test', provider: 'test-provider', infraUnits: [], resolverUnits: [unitA, unitB, unitC], orphanScan: null }),
		/simulated crash rendering GammaResolver/,
	);

	// The two units before the "crash" must be genuinely, fully written -- both the real file on
	// disk AND the manifest entry for it -- even though the overall emitUnits() call never returned.
	assert.ok(fs.existsSync(unitA.targetAbs), 'AlphaResolver must be written to disk before the crash');
	assert.ok(fs.existsSync(unitB.targetAbs), 'BetaResolver must be written to disk before the crash');
	assert.ok(!fs.existsSync(unitC.targetAbs), 'GammaResolver must NOT be written -- it never got past rendering');

	assert.ok(fs.existsSync(manifestPath(root)), 'the manifest file itself must exist after a partial run, not only after a clean one');
	const manifest = loadManifest(root);
	const relA = path.relative(root, unitA.targetAbs);
	const relB = path.relative(root, unitB.targetAbs);
	const relC = path.relative(root, unitC.targetAbs);
	assert.ok(manifest.files[relA], 'AlphaResolver must have a manifest entry -- this is the actual fix: previously only ONE saveManifest() call happened, at the very end, so a crash here would have left NEITHER unit recorded');
	assert.ok(manifest.files[relB], 'BetaResolver must have a manifest entry too');
	assert.ok(!manifest.files[relC], 'GammaResolver must have no manifest entry -- it was never written');

	// Closes the loop: re-running normally (GammaResolver fixed) must NOT require --force for
	// AlphaResolver/BetaResolver -- their content on disk still matches their now-correctly-recorded
	// manifest entries, so classifyFile() reports 'unchanged', not 'conflict'. Before this item, a
	// crash here would have left AlphaResolver/BetaResolver's real content on disk with NO manifest
	// entry, so the next run's classifyFile() would see "file exists, no manifest entry, content
	// happens to match a pristine render" -> 'adopt-unchanged' -- itself not a data-loss bug
	// (classifyFile() is fail-closed by construction), but a real class of "why does this look like
	// I never ran it" confusion that per-unit persistence now avoids entirely.
	const fixedUnitC = makeResolverUnit(root, 'GammaResolver');
	const result = emitUnits({ repoRoot: root, featureId: '001-crash-test', provider: 'test-provider', infraUnits: [], resolverUnits: [unitA, unitB, fixedUnitC], orphanScan: null });
	assert.equal(result.blocked, false, 'recovering from the crash must never require --force');
	const actionsByPath = Object.fromEntries(result.actions.map((a) => [a.path, a.action]));
	assert.equal(actionsByPath[relA], 'unchanged');
	assert.equal(actionsByPath[relB], 'unchanged');
	assert.equal(actionsByPath[relC], 'create');
});
