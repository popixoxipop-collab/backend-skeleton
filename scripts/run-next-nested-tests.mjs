import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '..');

export const SUITES = [
  { id: 'T01', sourcePaths: ['contracts/next', 'schemas/next'], testDir: 'test/contract-next' },
  { id: 'T02', sourcePaths: ['scanners/project-graph'], testDir: 'test/project-graph' },
  { id: 'T06', sourcePaths: ['scanners/language/python'], testDir: 'test/language-python' },
  { id: 'T08', sourcePaths: ['scanners/language/native-server'], testDir: 'test/language-native-server' },
  { id: 'T09', sourcePaths: ['contracts/reconciliation-next'], testDir: 'test/reconciliation-next' },
  { id: 'T11', sourcePaths: ['adapters/http-legacy-next'], testDir: 'test/http-legacy-next' },
  { id: 'T17', sourcePaths: ['adapters/game-next'], testDir: 'test/game-next' },
  { id: 'T18', sourcePaths: ['adapters/protocol-next'], testDir: 'test/protocol-next' },
  { id: 'T19', sourcePaths: ['test/conformance-next', 'test/corpus-next', 'evidence/next'], testDir: 'test/conformance-next' },
  { id: 'T20', sourcePaths: ['lib/trust-next'], testDir: 'test/trust-next' },
  { id: 'T22', sourcePaths: ['sdk/next'], testDir: 'test/sdk-next' }
];

function exists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

export function collectTests(root, relativeDir) {
  const dir = path.join(root, relativeDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
}

export function inspectSuite(suite, root = REPO_ROOT) {
  const sourcePresent = suite.sourcePaths.some((p) => exists(root, p));
  const testDirPresent = exists(root, suite.testDir);
  const tests = collectTests(root, suite.testDir);

  if (!sourcePresent && !testDirPresent) {
    return { id: suite.id, status: 'NOT_PRESENT', tests: [] };
  }
  if (!sourcePresent && testDirPresent) {
    return { id: suite.id, status: 'FAIL_ORPHAN_TESTS', tests };
  }
  if (sourcePresent && (!testDirPresent || tests.length === 0)) {
    return { id: suite.id, status: 'FAIL_MISSING_TESTS', tests };
  }
  return { id: suite.id, status: 'READY', tests };
}

export function runSuite(suite, root = REPO_ROOT) {
  const inspected = inspectSuite(suite, root);
  if (inspected.status === 'NOT_PRESENT') {
    console.log(`NESTED_SUITE ${suite.id} NOT_PRESENT`);
    return 0;
  }
  if (inspected.status !== 'READY') {
    console.error(`NESTED_SUITE ${suite.id} ${inspected.status}`);
    return 2;
  }

  const relativeTests = inspected.tests.map((p) => path.relative(root, p));
  console.log(`NESTED_SUITE ${suite.id} RUN ${relativeTests.length} files`);
  const result = spawnSync(process.execPath, ['--test', ...relativeTests], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) {
    console.error(result.error.stack || String(result.error));
    return 2;
  }
  return result.status ?? 2;
}

function main(argv) {
  const requested = argv.length ? argv : SUITES.map((s) => s.id);
  const byId = new Map(SUITES.map((s) => [s.id, s]));
  for (const id of requested) {
    const suite = byId.get(id);
    if (!suite) {
      console.error(`unknown nested suite: ${id}`);
      return 2;
    }
    const code = runSuite(suite);
    if (code !== 0) return code;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
