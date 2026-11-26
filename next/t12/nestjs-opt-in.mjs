#!/usr/bin/env node
// Explicit, checkout-only consumer of T04-shaped facts. This does not discover Nest source,
// register a production adapter, or turn static routes into verified operations.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildContract } from '../../contracts/emit.mjs';
import { projectNestJsFacts } from '../../adapters/http-wave-a/nestjs.mjs';

const MAX_FACT_BYTES = 1024 * 1024;

export function projectNestJsScanReport(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new TypeError('T04 facts must be an object');
  }
  const leaf = projectNestJsFacts(facts);
  const modules = new Map();
  for (const route of leaf.routes) {
    const split = route.handler.lastIndexOf('.');
    if (split < 1 || split === route.handler.length - 1) {
      throw new TypeError('NestJS route handler must identify a class and method');
    }
    const file = route.source?.file;
    if (typeof file !== 'string' || !file) {
      throw new TypeError('NestJS route source file is required');
    }
    const className = route.handler.slice(0, split);
    const method = route.handler.slice(split + 1);
    if (!modules.has(file)) modules.set(file, new Map());
    const controllers = modules.get(file);
    if (!controllers.has(className)) controllers.set(className, []);
    controllers.get(className).push({
      method, verb: route.method, path: route.path, file,
      line: Number.isInteger(route.source.line) ? route.source.line : null,
      operationId: null,
      operationIdSource: null,
      provenance: route.provenance,
    });
  }
  const related_modules = [...modules].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, controllers]) => ({
    module: file,
    controllers: [...controllers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([className, endpoints]) => ({ className, endpoints })),
  }));
  const unknowns = leaf.unknowns.map((item) => JSON.stringify(item));
  unknowns.push('source producer unverified: supplied T04-shaped facts were not produced from Nest source by this entry point');
  if (leaf.routes.length) {
    unknowns.push('global prefix unresolved: deployment prefix and RouterModule mounts were not inspected');
    unknowns.push('global authorization unresolved: global guards and authorization were not inspected');
  }
  return {
    schema: 'sbf.scan-report/2',
    terms: [],
    adapter: 'typescript-nestjs',
    confidence: 'low',
    api_surface_source: 'supplied T04-shaped static facts; no Nest source or runtime read',
    verdict: 'inventory',
    related_modules,
    collisions: [],
    unknowns,
    files_read: [],
  };
}

export function emitNestJsCandidateContract({ facts, featureId, featureUid }) {
  if (!/^[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(featureId ?? '')) {
    throw new TypeError('featureId must match the feature-contract schema');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(featureUid ?? '')) {
    throw new TypeError('featureUid must be a UUID');
  }
  const scanReport = projectNestJsScanReport(facts);
  const contract = buildContract({ featureId, featureUid, scanReport });
  return { scanReport, contract };
}

export function runNestJsOptIn(argv) {
  if (![2, 6].includes(argv.length) || argv[0] !== '--facts'
      || (argv.length === 6 && (argv[2] !== '--feature-id' || argv[4] !== '--feature-uid'))) {
    throw new TypeError('usage: node next/t12/nestjs-opt-in.mjs --facts <T04-facts.json> [--feature-id <id> --feature-uid <uuid>]');
  }
  const stat = fs.statSync(argv[1]);
  if (!stat.isFile() || stat.size > MAX_FACT_BYTES) throw new TypeError('facts must be a regular JSON file of at most 1 MiB');
  const facts = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
  return argv.length === 6
    ? emitNestJsCandidateContract({ facts, featureId: argv[3], featureUid: argv[5] })
    : projectNestJsScanReport(facts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(runNestJsOptIn(process.argv.slice(2))) + '\n');
  } catch (error) {
    process.stderr.write(`NestJS opt-in: ${error.message}\n`);
    process.exitCode = 1;
  }
}
