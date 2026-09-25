import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  extractRailsDslFacts,
  extractLaravelDslFacts,
  extractSymfonyRouteAttributeFacts,
} from './dsl-facts.mjs';
import { expandDslFacts } from './dsl-expand.mjs';
import {
  extractActiveRecordModelFacts,
  extractEloquentModelFacts,
} from './model-facts.mjs';

export const T07_CORPUS_CONTRACT = 'sbf.t07-ruby-php-corpus/1';
const SHA_RE = /^[0-9a-f]{40}$/i;
const FRAMEWORKS = new Set(['rails', 'laravel', 'symfony']);

function safeRel(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')) return false;
  return !value.split('/').some((part) => part === '..' || part === '');
}

export function validateT07CorpusManifest(value) {
  if (!value || value.contract !== T07_CORPUS_CONTRACT || !Array.isArray(value.entries)) {
    throw new TypeError(`expected ${T07_CORPUS_CONTRACT}`);
  }
  if (value.entries.length !== 9) throw new TypeError('T07 corpus must contain exactly nine pinned entries');
  const ids = new Set();
  const frameworks = new Map();
  for (const entry of value.entries) {
    if (!entry?.id || ids.has(entry.id)) throw new TypeError('corpus entry ids must be unique');
    ids.add(entry.id);
    if (!FRAMEWORKS.has(entry.framework)) throw new TypeError(`unsupported corpus framework: ${entry.framework}`);
    if (!entry.owner || !entry.repo || !SHA_RE.test(entry.ref ?? '')) throw new TypeError(`${entry.id}: owner/repo/exact 40-hex ref required`);
    if (!Array.isArray(entry.route_roots) || !Array.isArray(entry.model_roots)) throw new TypeError(`${entry.id}: route_roots/model_roots required`);
    for (const root of [...entry.route_roots, ...entry.model_roots]) {
      if (!safeRel(root)) throw new TypeError(`${entry.id}: unsafe root ${root}`);
    }
    frameworks.set(entry.framework, (frameworks.get(entry.framework) ?? 0) + 1);
  }
  for (const framework of FRAMEWORKS) {
    if (frameworks.get(framework) !== 3) throw new TypeError(`expected three ${framework} entries`);
  }
  return true;
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function exactCheckout(entry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bskel-t07-${entry.framework}-`));
  const url = `https://github.com/${entry.owner}/${entry.repo}.git`;
  try {
    sh('git', ['init', '--quiet'], dir);
    sh('git', ['remote', 'add', 'origin', url], dir);
    sh('git', ['fetch', '--quiet', '--depth', '1', 'origin', entry.ref], dir);
    sh('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
    const actual = sh('git', ['rev-parse', 'HEAD'], dir).trim();
    if (actual.toLowerCase() !== entry.ref.toLowerCase()) {
      throw new Error(`checkout mismatch: expected ${entry.ref}, got ${actual}`);
    }
    return dir;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function trackedFiles(root) {
  return sh('git', ['ls-files', '-z'], root).split('\0').filter(Boolean).sort();
}

function isUnder(file, roots) {
  return roots.some((root) => file === root || file.startsWith(`${root}/`));
}

function routeFiles(entry, files) {
  if (entry.framework === 'rails') {
    return files.filter((file) =>
      (file === 'config/routes.rb' || file.startsWith('config/routes/'))
      && file.endsWith('.rb')
      && isUnder(file, entry.route_roots));
  }
  if (entry.framework === 'laravel') {
    return files.filter((file) => file.endsWith('.php') && isUnder(file, entry.route_roots));
  }
  return files.filter((file) => file.endsWith('.php') && isUnder(file, entry.route_roots));
}

function modelFiles(entry, files) {
  if (entry.framework === 'symfony') return [];
  const ext = entry.framework === 'rails' ? '.rb' : '.php';
  return files.filter((file) => file.endsWith(ext) && isUnder(file, entry.model_roots));
}

function bump(obj, key, n = 1) {
  obj[key] = (obj[key] ?? 0) + n;
}

function scanRouteFile(entry, root, file) {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, 'utf8');
  if (entry.framework === 'symfony' && !source.includes('#[')) return null;
  const facts = entry.framework === 'rails'
    ? extractRailsDslFacts(source, { file })
    : entry.framework === 'laravel'
      ? extractLaravelDslFacts(source, { file })
      : extractSymfonyRouteAttributeFacts(source, { file });
  const expanded = expandDslFacts(facts);
  return { facts, expanded };
}

function scanModelFile(entry, root, file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (entry.framework === 'rails' && !/(?:<\s*ApplicationRecord\b|<\s*ActiveRecord::Base\b)/.test(source)) return null;
  if (entry.framework === 'laravel' && !/\bextends\s+(?:\\?Illuminate\\Database\\Eloquent\\Model|Model)\b/.test(source)) return null;
  return entry.framework === 'rails'
    ? extractActiveRecordModelFacts(source, { file })
    : extractEloquentModelFacts(source, { file });
}

export function scanT07CorpusCheckout(entry, root) {
  const files = trackedFiles(root);
  const routeCandidates = routeFiles(entry, files);
  const modelCandidates = modelFiles(entry, files);
  const report = {
    id: entry.id,
    framework: entry.framework,
    repository: `${entry.owner}/${entry.repo}`,
    ref: entry.ref,
    tracked_files: files.length,
    route_files_considered: routeCandidates.length,
    route_files_with_facts: 0,
    route_facts: 0,
    route_fact_status: {},
    route_fact_kinds: {},
    route_candidates: 0,
    route_unknowns: 0,
    route_unknown_codes: {},
    model_files_considered: modelCandidates.length,
    model_files_with_models: 0,
    models: 0,
    explicit_tables: 0,
    explicit_primary_keys: 0,
    model_unknowns: 0,
    model_unknown_codes: {},
  };

  for (const file of routeCandidates) {
    const scanned = scanRouteFile(entry, root, file);
    if (!scanned) continue;
    const { facts, expanded } = scanned;
    if (facts.facts.length) report.route_files_with_facts++;
    report.route_facts += facts.facts.length;
    for (const fact of facts.facts) {
      bump(report.route_fact_status, fact.status);
      bump(report.route_fact_kinds, fact.kind);
    }
    report.route_candidates += expanded.candidates.length;
    report.route_unknowns += expanded.unknowns.length;
    for (const unknown of expanded.unknowns) bump(report.route_unknown_codes, unknown.code);
  }

  for (const file of modelCandidates) {
    const scanned = scanModelFile(entry, root, file);
    if (!scanned) continue;
    if (scanned.models.length) report.model_files_with_models++;
    report.models += scanned.models.length;
    for (const model of scanned.models) {
      if (model.table) report.explicit_tables++;
      if (model.primaryKey) report.explicit_primary_keys++;
    }
    report.model_unknowns += scanned.unknowns.length;
    for (const unknown of scanned.unknowns) bump(report.model_unknown_codes, unknown.code);
  }
  return report;
}

export function runT07Corpus(manifest, { keepCheckouts = false } = {}) {
  validateT07CorpusManifest(manifest);
  const results = [];
  for (const entry of manifest.entries) {
    let root = null;
    try {
      root = exactCheckout(entry);
      results.push({ ...scanT07CorpusCheckout(entry, root), error: null });
    } catch (error) {
      results.push({
        id: entry.id,
        framework: entry.framework,
        repository: `${entry.owner}/${entry.repo}`,
        ref: entry.ref,
        error: String(error?.message ?? error),
      });
    } finally {
      if (root && !keepCheckouts) fs.rmSync(root, { recursive: true, force: true });
    }
  }
  return {
    contract: 'sbf.t07-ruby-php-corpus-report/1',
    generated_at: new Date().toISOString(),
    results,
  };
}
