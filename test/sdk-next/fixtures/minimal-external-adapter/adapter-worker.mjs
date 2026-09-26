export async function adapterWorker(request) {
	const base = {
		contract: 'sbf.adapter-worker/1',
		direction: 'response',
		requestId: request.requestId,
		adapterId: request.adapterId,
		diagnostics: [],
	};
	switch (request.operation) {
		case 'detect':
			return { ...base, status: 'ok', result: { detected: true, evidence: ['fixture:package-json'] } };
		case 'analyze':
			return {
				...base,
				status: 'ok',
				result: {
					facts: [{ kind: 'example.route', method: 'GET', path: '/example' }],
				},
			};
		case 'diagnostics':
			return {
				...base,
				status: 'ok',
				result: {},
				diagnostics: [{
					code: 'EXAMPLE_STATIC_ONLY',
					message: 'example adapter has no runtime proof',
					severity: 'info',
					status: 'unknown',
					file: 'fixtures/minimal/input.ts',
					startLine: 1,
				}],
			};
		case 'read-set':
			return { ...base, status: 'ok', result: { files: ['fixtures/minimal/input.ts'] } };
		default:
			return { ...base, status: 'unsupported', result: null };
	}
}
