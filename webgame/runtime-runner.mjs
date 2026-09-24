import fs from 'node:fs';
import path from 'node:path';
import { executeWebgamePlan } from './execution.mjs';
import { createOwnedProcessSession } from './process-session.mjs';

export class WebgameRuntimeExecutionError extends Error {
  constructor(message, { phase = null, detail = null } = {}) {
    super(message);
    this.name = 'WebgameRuntimeExecutionError';
    this.phase = phase;
    this.detail = detail;
  }
}

function sourceRoot(repoRoot, plan) {
  const root = path.resolve(repoRoot);
  const candidate = path.resolve(root, plan.source.root);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw new WebgameRuntimeExecutionError('webgame source root escapes repository', { phase: 'prepare' });
  }
  return candidate;
}

function readyUrl(plan) {
  return new URL(plan.serve.ready_path || '/', plan.serve.url).toString();
}

async function waitUntilReady(plan, { fetchImpl, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(readyUrl(plan), { redirect: 'manual' });
      if (response && response.status >= 200 && response.status < 500) return;
      last = `HTTP ${response?.status ?? 'unknown'}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new WebgameRuntimeExecutionError(`webgame server did not become ready within ${timeoutMs}ms${last ? `: ${last}` : ''}`, { phase: 'serve' });
}

export async function runWebgameRuntime(plan, {
  repoRoot,
  driver,
  processSession = null,
  fetchImpl = globalThis.fetch,
  buildTimeoutMs = 120000,
  readyTimeoutMs = 15000,
  readyPollMs = 100,
} = {}) {
  if (!plan || plan.schema !== 'sbf.webgame-execution-plan/1') throw new WebgameRuntimeExecutionError('runWebgameRuntime requires an execution plan', { phase: 'prepare' });
  if (!repoRoot) throw new WebgameRuntimeExecutionError('repoRoot is required', { phase: 'prepare' });
  if (!plan.execution.available) {
    return { schema: 'sbf.webgame-runtime-result/1', project_id: plan.project_id, verdict: 'blocked', blocked_by: [...plan.execution.blocked_by], scenarios: [] };
  }
  if (typeof fetchImpl !== 'function') throw new WebgameRuntimeExecutionError('fetch implementation is required', { phase: 'prepare' });
  const cwd = sourceRoot(repoRoot, plan);
  const session = processSession ?? createOwnedProcessSession({ repoRoot });
  try {
    const build = await session.run(plan.build.argv, { cwd, timeoutMs: buildTimeoutMs });
    if (build.code !== 0) {
      throw new WebgameRuntimeExecutionError(`webgame build failed with exit code ${build.code}`, { phase: 'build', detail: build });
    }
    const output = path.resolve(cwd, plan.build.output_dir);
    if (!fs.existsSync(output)) throw new WebgameRuntimeExecutionError(`webgame build output does not exist: ${plan.build.output_dir}`, { phase: 'build' });
    session.start(plan.serve.argv, { cwd });
    await waitUntilReady(plan, { fetchImpl, timeoutMs: readyTimeoutMs, pollMs: readyPollMs });
    return await executeWebgamePlan(plan, { driver });
  } finally {
    await session.stopAll();
  }
}
