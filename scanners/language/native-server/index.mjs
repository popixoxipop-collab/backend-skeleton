import { analyzeGoGinSource } from './go.mjs';
import { analyzeCSharpAspNetSource } from './csharp.mjs';
import { NATIVE_SERVER_PROTOCOL, normalizeBudget, validateMessage } from './protocol.mjs';

export { analyzeGoGinSource } from './go.mjs';
export { analyzeCSharpAspNetSource } from './csharp.mjs';
export { NATIVE_SERVER_PROTOCOL, DEFAULT_BUDGET, normalizeBudget, validateMessage, encodeNdjson, decodeNdjsonLine } from './protocol.mjs';

export const NATIVE_LANGUAGE_BACKENDS = Object.freeze({
	go: Object.freeze({ id: 'go-static-pilot', analyze: analyzeGoGinSource, execution: 'none' }),
	csharp: Object.freeze({ id: 'csharp-static-pilot', analyze: analyzeCSharpAspNetSource, execution: 'none' }),
});

export function analyzeNativeServerSource({ language, source, file = '<memory>' }) {
	const backend = NATIVE_LANGUAGE_BACKENDS[language];
	if (!backend) throw new Error(`native language backend is not implemented for ${JSON.stringify(language)}`);
	return backend.analyze(source, { file });
}

export function handleAnalyzeRequest(message) {
	validateMessage(message);
	if (message.kind !== 'analyze-request') throw new TypeError('handleAnalyzeRequest requires an analyze-request message');
	const budget = normalizeBudget(message.budget ?? {});
	const encodedInputBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
	if (encodedInputBytes > budget.maxInputBytes) throw new RangeError(`analysis request exceeds maxInputBytes (${encodedInputBytes} > ${budget.maxInputBytes})`);
	const result = analyzeNativeServerSource({ language: message.language, source: message.source, file: message.file });
	if (result.routes.length > budget.maxRoutes) throw new RangeError(`analysis exceeded maxRoutes (${result.routes.length} > ${budget.maxRoutes})`);
	if (result.diagnostics.length > budget.maxDiagnostics) throw new RangeError(`analysis exceeded maxDiagnostics (${result.diagnostics.length} > ${budget.maxDiagnostics})`);
	return {
		protocol: NATIVE_SERVER_PROTOCOL,
		kind: 'analyze-response',
		requestId: message.requestId,
		language: message.language,
		backend: NATIVE_LANGUAGE_BACKENDS[message.language].id,
		routes: result.routes,
		diagnostics: result.diagnostics,
		groups: result.groups,
		framework: result.framework,
		limitations: result.limitations,
	};
}
