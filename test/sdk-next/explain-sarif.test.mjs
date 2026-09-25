import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createSupportExplanation,
	diagnosticsToSarif,
	renderSupportExplanationMarkdown,
} from '../../sdk/next/index.mjs';

test('support explanation preserves unknown/conflict and says confidence is not runtime proof', () => {
	const report = createSupportExplanation({
		subject: 'project/api/users#get',
		adapterId: 'typescript-nestjs',
		capabilities: [{
			name: 'api.routes',
			status: 'partial',
			evidenceRefs: ['source:controller'],
			constraints: ['global prefix unresolved'],
			nextActions: ['supply an approved runtime route snapshot'],
		}],
		fields: [{
			name: 'http.path',
			status: 'conflict',
			provenanceRefs: ['source:controller', 'spec:openapi'],
			conflicts: [{ value: '/users' }, { value: '/api/users' }],
			constraints: ['source/spec revision equivalence not established'],
			nextActions: ['reconcile on the same immutable build'],
		}],
	});
	assert.equal(report.fields[0].status, 'conflict');
	assert.equal(report.fields[0].conflicts.length, 2);
	assert.match(report.notes[0], /not runtime-behavior proof/);

	const markdown = renderSupportExplanationMarkdown(report);
	assert.match(markdown, /global prefix unresolved/);
	assert.match(markdown, /source:controller/);
	assert.match(markdown, /reconcile on the same immutable build/);
});

test('SARIF projection keeps bskel status and evidence metadata', () => {
	const sarif = diagnosticsToSarif([{
		code: 'BSKEL_SDK_UNKNOWN_ROUTE',
		title: 'Unknown route',
		severity: 'warning',
		message: 'global prefix could not be proven',
		file: 'src\\controller.ts',
		startLine: 7,
		status: 'unknown',
		adapterId: 'typescript-nestjs',
		evidenceRefs: ['source:abc'],
	}]);
	assert.equal(sarif.version, '2.1.0');
	assert.equal(sarif.runs[0].results[0].level, 'warning');
	assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'src/controller.ts');
	assert.equal(sarif.runs[0].results[0].properties.bskelStatus, 'unknown');
	assert.deepEqual(sarif.runs[0].results[0].properties.evidenceRefs, ['source:abc']);
});
