function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function requirePositiveInteger(name, value) {
	if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
	return value;
}

function normalizeTasks(tasks) {
	if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
	const byId = new Map();
	for (const task of tasks) {
		if (!task || typeof task.id !== 'string' || task.id === '') throw new TypeError('every task requires a non-empty id');
		if (byId.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
		const dependsOn = task.dependsOn ?? [];
		if (!Array.isArray(dependsOn) || dependsOn.some((x) => typeof x !== 'string')) throw new TypeError(`${task.id}: dependsOn must be a string array`);
		const estimatedBytes = task.estimatedBytes ?? 0;
		if (!Number.isInteger(estimatedBytes) || estimatedBytes < 0) throw new TypeError(`${task.id}: estimatedBytes must be a non-negative integer`);
		byId.set(task.id, { ...task, dependsOn: [...new Set(dependsOn)].sort(compareText), estimatedBytes });
	}
	for (const task of byId.values()) {
		for (const dep of task.dependsOn) if (!byId.has(dep)) throw new Error(`${task.id}: missing dependency ${dep}`);
		if (task.dependsOn.includes(task.id)) throw new Error(`${task.id}: self dependency`);
	}
	return byId;
}

function assertAcyclic(byId) {
	const indegree = new Map([...byId.keys()].map((id) => [id, 0]));
	const dependents = new Map();
	for (const task of byId.values()) {
		indegree.set(task.id, task.dependsOn.length);
		for (const dep of task.dependsOn) {
			if (!dependents.has(dep)) dependents.set(dep, []);
			dependents.get(dep).push(task.id);
		}
	}
	const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id).sort(compareText);
	let seen = 0;
	while (queue.length) {
		const id = queue.shift();
		seen += 1;
		for (const child of dependents.get(id) ?? []) {
			const n = indegree.get(child) - 1;
			indegree.set(child, n);
			if (n === 0) {
				queue.push(child);
				queue.sort(compareText);
			}
		}
	}
	if (seen !== byId.size) throw new Error('task dependency graph contains a cycle');
}

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

// A deterministic admission scheduler for parse/scan work. `estimatedBytes` is reservation
// accounting, not a claim about RSS. A task larger than the hard budget is blocked before worker
// execution; dependencies of a failed/blocked task are blocked rather than silently run against
// missing inputs. Ready tasks are admitted by id for repeatable behavior.
export async function runTaskGraph(tasks, worker, {
	maxConcurrency = 4,
	maxEstimatedBytesInFlight = 512 * 1024 * 1024,
} = {}) {
	if (typeof worker !== 'function') throw new TypeError('worker must be a function');
	requirePositiveInteger('maxConcurrency', maxConcurrency);
	requirePositiveInteger('maxEstimatedBytesInFlight', maxEstimatedBytesInFlight);
	const byId = normalizeTasks(tasks);
	assertAcyclic(byId);

	const state = new Map([...byId.keys()].map((id) => [id, { id, status: 'pending' }]));
	const running = new Map();
	let bytesInFlight = 0;
	let peakEstimatedBytesInFlight = 0;
	let peakConcurrency = 0;
	let maxReadyQueue = 0;
	let byteAdmissionDeferrals = 0;
	let concurrencyAdmissionDeferrals = 0;
	let started = 0;

	const terminal = new Set(['passed', 'failed', 'blocked']);
	const markBlockedDependencies = () => {
		let changed = false;
		for (const task of [...byId.values()].sort((a, b) => compareText(a.id, b.id))) {
			const current = state.get(task.id);
			if (current.status !== 'pending') continue;
			const badDep = task.dependsOn.find((dep) => ['failed', 'blocked'].includes(state.get(dep).status));
			if (badDep) {
				state.set(task.id, { id: task.id, status: 'blocked', reason: 'DEPENDENCY_NOT_PASSED', dependency: badDep });
				changed = true;
			}
		}
		return changed;
	};

	while ([...state.values()].some((x) => !terminal.has(x.status))) {
		markBlockedDependencies();
		let admitted = false;
		const ready = [...byId.values()]
			.filter((task) => state.get(task.id).status === 'pending' && task.dependsOn.every((dep) => state.get(dep).status === 'passed'))
			.sort((a, b) => compareText(a.id, b.id));
		maxReadyQueue = Math.max(maxReadyQueue, ready.length);

		for (const task of ready) {
			if (running.size >= maxConcurrency) {
				concurrencyAdmissionDeferrals += 1;
				break;
			}
			if (task.estimatedBytes > maxEstimatedBytesInFlight) {
				state.set(task.id, {
					id: task.id,
					status: 'blocked',
					reason: 'RESOURCE_BUDGET_EXCEEDED',
					estimated_bytes: task.estimatedBytes,
					budget_bytes: maxEstimatedBytesInFlight,
				});
				admitted = true;
				continue;
			}
			if (bytesInFlight + task.estimatedBytes > maxEstimatedBytesInFlight) {
				byteAdmissionDeferrals += 1;
				continue;
			}

			state.set(task.id, { id: task.id, status: 'running' });
			bytesInFlight += task.estimatedBytes;
			peakEstimatedBytesInFlight = Math.max(peakEstimatedBytesInFlight, bytesInFlight);
			peakConcurrency = Math.max(peakConcurrency, running.size + 1);
			started += 1;
			admitted = true;

			const promise = Promise.resolve()
				.then(() => worker(task))
				.then(
					(value) => state.set(task.id, { id: task.id, status: 'passed', value }),
					(error) => state.set(task.id, { id: task.id, status: 'failed', error: message(error) }),
				)
				.finally(() => {
					bytesInFlight -= task.estimatedBytes;
					running.delete(task.id);
				});
			running.set(task.id, promise);
		}

		if (running.size > 0) {
			if (!admitted || running.size >= maxConcurrency || !ready.length) await Promise.race(running.values());
			else await Promise.resolve();
			continue;
		}

		markBlockedDependencies();
		const pending = [...state.values()].filter((x) => x.status === 'pending');
		if (pending.length > 0) throw new Error(`scheduler made no progress with pending tasks: ${pending.map((x) => x.id).sort().join(', ')}`);
	}

	const results = [...state.values()].sort((a, b) => compareText(a.id, b.id));
	return {
		schema: 'sbf.scan-scheduler-result/1',
		results,
		metrics: {
			tasks: results.length,
			started,
			passed: results.filter((x) => x.status === 'passed').length,
			failed: results.filter((x) => x.status === 'failed').length,
			blocked: results.filter((x) => x.status === 'blocked').length,
			peak_concurrency: peakConcurrency,
			peak_estimated_bytes_in_flight: peakEstimatedBytesInFlight,
			max_ready_queue: maxReadyQueue,
			byte_admission_deferrals: byteAdmissionDeferrals,
			concurrency_admission_deferrals: concurrencyAdmissionDeferrals,
			resource_budget_blocked: results.filter((x) => x.reason === 'RESOURCE_BUDGET_EXCEEDED').length,
			dependency_blocked: results.filter((x) => x.reason === 'DEPENDENCY_NOT_PASSED').length,
		},
	};
}
