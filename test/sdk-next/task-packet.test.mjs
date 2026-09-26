import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createAdapterTaskPacket,
	renderTaskPacketMarkdown,
	validateAdapterTaskPacket,
} from '../../sdk/next/index.mjs';

test('task packet keeps ownership and safety constraints copyable', () => {
	const packet = createAdapterTaskPacket({
		taskId: 'HTTP-typescript-nestjs-02',
		targetId: 'HTTP-typescript-nestjs',
		baseSha: '5472a8b82655840d1d3ce76cb926987376e37ca6',
		writeScope: ['adapters/http-wave-a/typescript-nestjs/**'],
		fixtures: ['test/fixtures/typescript-nestjs/minimal'],
		mandatoryTests: ['node --test test/typescript-nestjs.test.mjs'],
	});
	assert.equal(validateAdapterTaskPacket(packet).ok, true);
	assert.equal(packet.constraints.some((x) => x.includes('no automatic package install')), true);
	const markdown = renderTaskPacketMarkdown(packet);
	assert.match(markdown, /HTTP-typescript-nestjs-02/);
	assert.match(markdown, /Write scope/);
	assert.match(markdown, /unknown or unsupported semantics/);
});

test('task packet rejects a non-pinned base revision', () => {
	assert.throws(() => createAdapterTaskPacket({
		taskId: 'X',
		targetId: 'Y',
		baseSha: 'main',
		writeScope: ['adapter/**'],
		fixtures: ['fixture'],
		mandatoryTests: ['test'],
	}), /baseSha/);
});
