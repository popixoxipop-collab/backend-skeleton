#!/usr/bin/env node
// T11-02: explicit opt-in consumer of the *existing* legacy + presence bridge.
// Reads a JSON report envelope on stdin. Does not load target project code,
// register adapters, infer support, mutate baselines, or promote anything.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bridgeLegacyHttpWithObservation } from './observed-bridge-v1.mjs';
import { summarizeLegacyHttpReport } from '../../adapters/http-legacy-next/bridge.mjs';

export const T11_REPORT_CONSUMER_V1 = 'bskel.t11-observed-report-consumer/1';
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;

export function consumeObservedLegacyReport({ adapter, report, root } = {}) {
  const bound = bridgeLegacyHttpWithObservation({ adapter, report, root });
  const fields = bound.report_observation.fields;
  const sections = Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [field, {
      state: value.state,
      itemCount: value.itemCount,
    }]),
  );
  return {
    schema: T11_REPORT_CONSUMER_V1,
    adapter_id: bound.source_adapter_id,
    legacy_bridge_schema: bound.legacy_bridge.schema,
    legacy_semantic_sha256: bound.legacy_semantic_sha256,
    observation_schema: bound.report_observation.schema,
    observation_sha256: bound.report_observation_sha256,
    observation_quality: bound.report_observation.quality,
    sections,
    module_sections: bound.report_observation.modules,
    legacy_summary: summarizeLegacyHttpReport(bound.legacy_bridge.legacy_report),
    // Deliberately do not conflate the historical summary with presence.
    presence_only: true,
    runtime_certified: false,
    source_authorized: false,
    promotion_allowed: false,
  };
}

export async function runCli({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_INPUT_BYTES) throw new Error('T11_CONSUMER_INPUT_TOO_LARGE');
      chunks.push(bytes);
    }
    if (size === 0) throw new Error('T11_CONSUMER_INPUT_EMPTY');
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const output = consumeObservedLegacyReport(input);
    stdout.write(JSON.stringify(output) + '\n');
    return 0;
  } catch (error) {
    stderr.write(`T11_CONSUMER_REJECTED: ${error.message}\n`);
    return 2;
  }
}

function isDirectInvocation(argv1) {
  if (!argv1) return false;
  try {
    // npm exposes bins through a symlink on POSIX. Comparing file URLs alone
    // mistakes that installed executable for an import and silently does
    // nothing, so compare resolved filesystem identities instead.
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  process.exitCode = await runCli();
}
