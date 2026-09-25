import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSupportEvidenceMatrix,
	createSupportExplanation,
	diagnosticsToSarif,
	renderSupportEvidenceMatrixMarkdown,
	supportEvidenceMatrixDiagnostics,
} from '../../sdk/next/index.mjs';

function explanation(adapterId, capabilities) {
	return createSupportExplanation({
		subject: adapterId + ':project',
		adapterId,
		capabilities,
		fields: [],
	});
}

test('support matrix is deterministic and sorts adapters/capabilities', () => {
	const a = explanation('python-fastapi', [{
		name: 'api.routes',
		status: 'supported',
		evidenceRefs: ['source:b'],
		constraints: [],
		nextActions: [],
	}, {
		name: 'api.security',
		status: 'unknown',
		evidenceRefs: [],
		constraints: ['runtime enforcement not observed'],
		nextActions: ['run approved security probes'],
	}]);
	const b = explanation('java-spring', [{
		name: 'api.routes',
		status: 'supported',
		evidenceRefs: ['source:a'],
		constraints: [],
		nextActions: [],
	}]);

	const first = buildSupportEvidenceMatrix([a, b]);
	const second = buildSupportEvidenceMatrix([b, a]);
	assert.deepEqual(first, second);
	assert.deepEqual(first.capabilityNames, ['api.routes', 'api.security']);
	assert.deepEqual(first.rows.map((row) => row.adapterId), ['java-spring', 'python-fastapi']);
	assert.equal(first.rows[0].capabilities['api.security'].status, 'unknown');
});

test('contradictory reports for one adapter become conflict instead of choosing a winner', () => {
	const source = explanation('typescript-nestjs', [{
		name: 'api.routes',
		status: 'supported',
		evidenceRefs: ['source:controller'],
		constraints: [],
		nextActions: [],
	}]);
	const runtime = explanation('typescript-nestjs', [{
		name: 'api.routes',
		status: 'unsupported',
		evidenceRefs: ['runtime:snapshot'],
		constraints: ['route registration disabled by profile'],
		nextActions: ['inspect profile mismatch'],
	}]);

	const matrix = buildSupportEvidenceMatrix([source, runtime]);
	const cell = matrix.rows[0].capabilities['api.routes'];
	assert.equal(cell.status, 'conflict');
	assert.deepEqual(cell.evidenceRefs, ['runtime:snapshot', 'source:controller']);
	assert.deepEqual(cell.constraints, ['route registration disabled by profile']);
});

test('partial and unknown propagate conservatively across multiple reports', () => {
	const staticReport = explanation('typescript-nestjs', [{
		name: 'api.request.schema',
		status: 'partial',
		evidenceRefs: ['source:dto'],
		constraints: ['validation pipe config unresolved'],
		nextActions: [],
	}]);
	const missingRuntime = explanation('typescript-nestjs', [{
		name: 'api.request.schema',
		status: 'unknown',
		evidenceRefs: [],
		constraints: ['runtime schema not supplied'],
		nextActions: ['supply approved OpenAPI/runtime snapshot'],
	}]);

	const matrix = buildSupportEvidenceMatrix([staticReport, missingRuntime]);
	assert.equal(matrix.rows[0].capabilities['api.request.schema'].status, 'unknown');
});

test('matrix diagnostics and SARIF preserve unresolved support states', () => {
	const matrix = buildSupportEvidenceMatrix([
		explanation('java-spring', [{
			name: 'api.routes',
			status: 'supported',
			evidenceRefs: ['source:a'],
			constraints: [],
			nextActions: [],
		}]),
		explanation('python-fastapi', [{
			name: 'api.routes',
			status: 'partial',
			evidenceRefs: ['source:b'],
			constraints: ['operation identity requires OpenAPI'],
			nextActions: ['supply OpenAPI'],
		}]),
	]);
	const diagnostics = supportEvidenceMatrixDiagnostics(matrix);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].adapterId, 'python-fastapi');
	assert.equal(diagnostics[0].status, 'partial');
	const sarif = diagnosticsToSarif(diagnostics);
	assert.equal(sarif.runs[0].results[0].properties.bskelStatus, 'partial');
});

test('Markdown matrix escapes untrusted adapter/capability data from table structure', () => {
	const matrix = {
		contract: 'sbf.support-evidence-matrix/1',
		capabilityNames: ['api|routes'],
		rows: [{
			adapterId: 'example|unsafe',
			capabilities: {
				'api|routes': {
					status: 'unknown',
					evidenceRefs: [],
					constraints: [],
					nextActions: [],
				},
			},
		}],
		note: 'note <unsafe>',
	};
	const markdown = renderSupportEvidenceMatrixMarkdown(matrix);
	assert.match(markdown, /api\\\|routes/);
	assert.match(markdown, /example\\\|unsafe/);
	assert.match(markdown, /&lt;unsafe&gt;/);
});


test('support matrix treats prototype-like capability names as ordinary data', () => {
	const report = explanation('typescript-nestjs', [
		{
			name: '__proto__',
			status: 'partial',
			evidenceRefs: ['source:a'],
			constraints: [],
			nextActions: [],
		},
		{
			name: 'constructor',
			status: 'unknown',
			evidenceRefs: [],
			constraints: [],
			nextActions: [],
		},
	]);
	const matrix = buildSupportEvidenceMatrix([report]);
	const caps = matrix.rows[0].capabilities;
	assert.equal(Object.prototype.polluted, undefined);
	assert.equal(Object.hasOwn(caps, '__proto__'), true);
	assert.equal(Object.hasOwn(caps, 'constructor'), true);
	assert.equal(caps.__proto__.status, 'partial');
	assert.equal(caps.constructor.status, 'unknown');

	const markdown = renderSupportEvidenceMatrixMarkdown(matrix);
	assert.match(markdown, /__proto__/);
	assert.match(markdown, /constructor/);

	const diagnostics = supportEvidenceMatrixDiagnostics(matrix);
	assert.deepEqual(diagnostics.map((item) => item.status).sort(), ['partial', 'unknown']);
});
