#!/usr/bin/env node
import { DEFAULT_BUDGET, NATIVE_SERVER_PROTOCOL, decodeNdjsonLine, encodeNdjson } from './protocol.mjs';
import { handleAnalyzeRequest } from './index.mjs';

async function readBoundedStdin(limit) {
	const chunks = [];
	let total = 0;
	for await (const chunk of process.stdin) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.length;
		if (total > limit) throw new RangeError(`worker stdin exceeds bootstrap input limit (${total} > ${limit})`);
		chunks.push(bytes);
	}
	return Buffer.concat(chunks, total);
}

function errorCode(err) {
	if (err instanceof RangeError) return 'BUDGET_EXCEEDED';
	if (err instanceof TypeError) return 'INVALID_REQUEST';
	return 'ANALYSIS_FAILED';
}

async function main() {
	let request = null;
	try {
		const input = await readBoundedStdin(DEFAULT_BUDGET.maxInputBytes);
		request = decodeNdjsonLine(input);
		if (request.kind !== 'analyze-request') throw new TypeError('native worker accepts analyze-request messages only');
		const response = handleAnalyzeRequest(request);
		process.stdout.write(encodeNdjson(response, request.budget ?? {}));
	} catch (err) {
		if (request?.requestId) {
			try {
				process.stdout.write(encodeNdjson({
					protocol: NATIVE_SERVER_PROTOCOL,
					kind: 'error',
					requestId: request.requestId,
					code: errorCode(err),
					message: err instanceof Error ? err.message : String(err),
				}, request.budget ?? {}));
			} catch {
				// If the requested output budget is too small even for the error envelope,
				// stdout stays empty and stderr remains the only signal.
			}
		}
		process.stderr.write(`native language worker: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 2;
	}
}

await main();
