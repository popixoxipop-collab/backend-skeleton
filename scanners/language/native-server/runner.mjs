import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGET, decodeNdjsonLine, normalizeBudget, validateMessage } from './protocol.mjs';

const WORKER_PATH = fileURLToPath(new URL('./worker.mjs', import.meta.url));

function workerEnvironment() {
	// The static worker uses an absolute Node executable plus an absolute worker module path.
	// It needs no target/project environment and receives no ambient host variables at all.
	// If a future compiler helper needs runner-owned bootstrap variables, that belongs in the
	// separately reviewed T20/T16 execution profile rather than this static worker default.
	return Object.create(null);
}

function boundedText(value, limit = 4096) {
	const text = String(value ?? '');
	return text.length <= limit ? text : text.slice(0, limit) + '…';
}

export class NativeWorkerRunError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = 'NativeWorkerRunError';
		this.code = code;
		this.status = details.status ?? null;
		this.signal = details.signal ?? null;
		this.stderr = boundedText(details.stderr ?? '');
	}
}

function requestLine(message, budget) {
	validateMessage(message);
	if (message.kind !== 'analyze-request') throw new TypeError('runNativeServerWorker requires an analyze-request message');
	const line = JSON.stringify(message) + '\n';
	const bytes = Buffer.byteLength(line, 'utf8');
	if (bytes > budget.maxInputBytes) throw new RangeError(`analysis request exceeds maxInputBytes (${bytes} > ${budget.maxInputBytes})`);
	return line;
}

function decodeWorkerOutput(stdout, budget) {
	const bytes = Buffer.byteLength(stdout ?? '', 'utf8');
	if (bytes > budget.maxOutputBytes) {
		throw new NativeWorkerRunError('WORKER_OUTPUT_LIMIT', `worker stdout exceeds maxOutputBytes (${bytes} > ${budget.maxOutputBytes})`);
	}
	return decodeNdjsonLine(stdout, { maxInputBytes: budget.maxOutputBytes });
}

const BUDGET_KEYS = Object.freeze(['maxInputBytes', 'maxOutputBytes', 'maxDiagnostics', 'maxRoutes', 'wallTimeMs']);

function effectiveBudgetForProfile(requestBudgetInput, profileBudget) {
	const explicit = requestBudgetInput ?? {};
	if (explicit == null || typeof explicit !== 'object' || Array.isArray(explicit)) throw new TypeError('budget must be an object');
	const requested = normalizeBudget(explicit);
	const effective = {};
	for (const key of BUDGET_KEYS) {
		if (Object.prototype.hasOwnProperty.call(explicit, key) && requested[key] > profileBudget[key]) {
			throw new NativeWorkerRunError(
				'WORKER_BUDGET_EXPANSION',
				`request ${key}=${requested[key]} exceeds runner profile limit ${profileBudget[key]}`,
			);
		}
		effective[key] = Math.min(requested[key], profileBudget[key]);
	}
	return Object.freeze(effective);
}

export function runNativeServerWorker(message, { spawnFn = spawnSync, profileLimits = DEFAULT_BUDGET } = {}) {
	const profileBudget = normalizeBudget(profileLimits);
	const budget = effectiveBudgetForProfile(message?.budget, profileBudget);
	if (budget.maxInputBytes > DEFAULT_BUDGET.maxInputBytes) {
		throw new NativeWorkerRunError(
			'WORKER_PROFILE_UNSUPPORTED',
			`effective maxInputBytes=${budget.maxInputBytes} exceeds the worker bootstrap limit ${DEFAULT_BUDGET.maxInputBytes}`,
		);
	}
	const wireMessage = { ...message, budget };
	const input = requestLine(wireMessage, budget);
	const child = spawnFn(process.execPath, [WORKER_PATH], {
		input,
		encoding: 'utf8',
		windowsHide: true,
		shell: false,
		timeout: budget.wallTimeMs,
		maxBuffer: budget.maxOutputBytes + 64 * 1024,
		env: workerEnvironment(),
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	if (child?.error) {
		if (child.error.code === 'ETIMEDOUT') {
			throw new NativeWorkerRunError('WORKER_TIMEOUT', `native language worker exceeded wallTimeMs (${budget.wallTimeMs})`, {
				status: child.status, signal: child.signal, stderr: child.stderr,
			});
		}
		if (child.error.code === 'ENOBUFS') {
			throw new NativeWorkerRunError('WORKER_OUTPUT_LIMIT', 'native language worker exceeded the process output buffer', {
				status: child.status, signal: child.signal, stderr: child.stderr,
			});
		}
		throw new NativeWorkerRunError('WORKER_SPAWN_FAILED', child.error.message || 'native language worker failed to start', {
			status: child.status, signal: child.signal, stderr: child.stderr,
		});
	}

	let envelope = null;
	if (child?.stdout) {
		try {
			envelope = decodeWorkerOutput(child.stdout, budget);
		} catch (err) {
			if (child.status === 0) throw err;
		}
	}

	if (child?.status !== 0) {
		if (envelope?.kind === 'error' && envelope.requestId === message.requestId) {
			throw new NativeWorkerRunError(envelope.code, envelope.message, {
				status: child.status, signal: child.signal, stderr: child.stderr,
			});
		}
		throw new NativeWorkerRunError('WORKER_FAILED', `native language worker exited with status ${child?.status ?? 'unknown'}`, {
			status: child?.status, signal: child?.signal, stderr: child?.stderr,
		});
	}

	if (!envelope) throw new NativeWorkerRunError('WORKER_EMPTY_OUTPUT', 'native language worker returned no response');
	if (envelope.kind !== 'analyze-response') {
		throw new NativeWorkerRunError('WORKER_PROTOCOL_MISMATCH', `expected analyze-response, got ${JSON.stringify(envelope.kind)}`);
	}
	if (envelope.requestId !== message.requestId) {
		throw new NativeWorkerRunError('WORKER_REQUEST_MISMATCH', 'native language worker response requestId does not match the request');
	}
	if (envelope.language !== message.language) {
		throw new NativeWorkerRunError('WORKER_LANGUAGE_MISMATCH', 'native language worker response language does not match the request');
	}
	if (child.stderr) {
		throw new NativeWorkerRunError('WORKER_STDERR', 'native language worker wrote to stderr on a successful exit', {
			status: child.status, signal: child.signal, stderr: child.stderr,
		});
	}
	return envelope;
}

export const NATIVE_WORKER_PATH = WORKER_PATH;
