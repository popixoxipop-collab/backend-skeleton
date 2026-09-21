import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../scanners/registry.mjs';
import {
	GAMEPLAY_PROVIDERS,
	GAMEPLAY_PROVIDER_LOAD_ERRORS,
	gameplayProviderById,
	loadGameplayProviders,
} from '../gameplay/registry.mjs';

function fixtureDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-provider-registry-'));
}

function writeProvider(dir, filename, body) {
	fs.writeFileSync(path.join(dir, filename), body);
}

function fixture({ id = 'fixture', contract = "'sbf.gameplay-provider/1'", requires = "['game.events']" } = {}) {
	return `export const provider = {
  contract: ${contract},
  id: '${id}',
  title: 'Fixture provider',
  requiresCapabilities: ${requires},
  outputs: { spec: [] },
  plan() { return { schema: 'sbf.gameplay-plan/1', provider: '${id}', emission: { available: false, blocked_by: [], deferred_outputs: [] }, loops: [], notes: [] }; },
};\n`;
}

test('real gameplay registry loads the Unreal read-only planner and has no load errors', () => {
	assert.deepEqual(GAMEPLAY_PROVIDER_LOAD_ERRORS, []);
	assert.deepEqual(GAMEPLAY_PROVIDERS.map((provider) => provider.id), ['unreal-python']);
});

test('gameplay providers use zero-registration discovery and exact id lookup', async () => {
	const dir = fixtureDir();
	writeProvider(dir, 'aaa.mjs', fixture({ id: 'aaa' }));
	writeProvider(dir, 'bbb.mjs', fixture({ id: 'bbb' }));
	const { providers, errors } = await loadGameplayProviders({ providersDir: dir });
	assert.deepEqual(errors, []);
	assert.equal(gameplayProviderById(providers, 'aaa').id, 'aaa');
	assert.equal(gameplayProviderById(providers, 'missing'), null);
});

test('malformed gameplay providers fail closed without hiding valid siblings', async () => {
	const dir = fixtureDir();
	writeProvider(dir, 'good.mjs', fixture({ id: 'good' }));
	writeProvider(dir, 'missing-plan.mjs', `export const provider = { contract: 'sbf.gameplay-provider/1', id: 'missing-plan', title: 'Fixture', requiresCapabilities: [], outputs: { spec: [] } };\n`);
	writeProvider(dir, 'bad-capability.mjs', fixture({ id: 'bad-capability', requires: "['codegen.handles']" }));
	writeProvider(dir, 'wrong-version.mjs', fixture({ id: 'wrong-version', contract: "'sbf.gameplay-provider/99'" }));
	const { providers, errors } = await loadGameplayProviders({ providersDir: dir });
	assert.deepEqual(providers.map((provider) => provider.id), ['good']);
	const byFile = Object.fromEntries(errors.map((error) => [path.basename(error.file), error.message]));
	assert.match(byFile['missing-plan.mjs'], /provider\.plan must be a function/);
	assert.match(byFile['bad-capability.mjs'], /gameplay-provider\.schema\.json/);
	assert.match(byFile['wrong-version.mjs'], /sbf\.gameplay-provider\/99/);
});

test('the planner requires only parser-backed capabilities and does not make codegen.gameplay true', () => {
	const adapter = ADAPTERS.find((candidate) => candidate.id === 'unreal-python');
	const provider = gameplayProviderById(GAMEPLAY_PROVIDERS, 'unreal-python');
	assert.ok(adapter);
	assert.ok(provider);
	for (const capability of provider.requiresCapabilities) assert.equal(adapter.capabilities[capability], true);
	assert.equal(adapter.capabilities['codegen.gameplay'], false);
});
