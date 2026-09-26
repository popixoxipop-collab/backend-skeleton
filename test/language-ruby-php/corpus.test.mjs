import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  scanT07CorpusCheckout,
  validateT07CorpusManifest,
  runT07Corpus,
  digestT07ReadSet,
} from '../../scanners/language/ruby-php/corpus.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, 'corpus-manifest.json'), 'utf8'));

function localRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t07-corpus-test-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

test('real-repo corpus manifest is exact-pinned and balanced three-per-framework', () => {
  assert.equal(validateT07CorpusManifest(MANIFEST), true);
  const counts = Object.fromEntries(['rails', 'laravel', 'symfony'].map((framework) => [
    framework, MANIFEST.entries.filter((entry) => entry.framework === framework).length,
  ]));
  assert.deepEqual(counts, { rails: 3, laravel: 3, symfony: 3 });
  assert.ok(MANIFEST.entries.every((entry) => /^[0-9a-f]{40}$/.test(entry.ref)));
});

test('manifest rejects an unpinned ref and an unsafe source root', () => {
  const unpinned = structuredClone(MANIFEST);
  unpinned.entries[0].ref = 'main';
  assert.throws(() => validateT07CorpusManifest(unpinned), /exact 40-hex ref/);

  const unsafe = structuredClone(MANIFEST);
  unsafe.entries[0].route_roots = ['../config'];
  assert.throws(() => validateT07CorpusManifest(unsafe), /unsafe root/);
});

test('Rails local corpus path aggregates DSL candidates and explicit model metadata', () => {
  const root = localRepo({
    'config/routes.rb': 'resources :widgets, only: [:index, :show]\n',
    'app/models/widget.rb': [
      'class Widget < ApplicationRecord',
      '  self.table_name = "inventory_widgets"',
      '  self.primary_key = "widget_uuid"',
      'end',
      '',
    ].join('\n'),
    'README.md': 'ignored',
  });
  try {
    const report = scanT07CorpusCheckout({
      id: 'local-rails', framework: 'rails', owner: 'local', repo: 'rails', ref: '0'.repeat(40),
      route_roots: ['config'], model_roots: ['app/models'],
    }, root);
    assert.equal(report.route_files_considered, 1);
    assert.equal(report.route_facts, 1);
    assert.equal(report.route_candidates, 2);
    assert.equal(report.models, 1);
    assert.equal(report.explicit_tables, 1);
    assert.equal(report.explicit_primary_keys, 1);
    assert.equal(report.source_read_set_count, 2);
    assert.deepEqual(
      report.source_read_set.map((entry) => [entry.path, entry.roles]),
      [
        ['app/models/widget.rb', ['model']],
        ['config/routes.rb', ['route']],
      ],
    );
    assert.equal(report.source_read_set_sha256, digestT07ReadSet(report.source_read_set));
    assert.equal(report.source_read_set.some((entry) => entry.path === 'README.md'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Laravel local corpus path aggregates grouped routes and Eloquent explicit metadata', () => {
  const root = localRepo({
    'routes/api.php': [
      "Route::prefix('api')->group(function () {",
      "  Route::apiResource('projects', ProjectController::class)->only(['index', 'show']);",
      '});',
      '',
    ].join('\n'),
    'app/Models/Project.php': [
      '<?php',
      'class Project extends Model {',
      "  protected $table = 'projects_live';",
      "  protected $primaryKey = 'project_uuid';",
      '}',
      '',
    ].join('\n'),
  });
  try {
    const report = scanT07CorpusCheckout({
      id: 'local-laravel', framework: 'laravel', owner: 'local', repo: 'laravel', ref: '0'.repeat(40),
      route_roots: ['routes'], model_roots: ['app/Models'],
    }, root);
    assert.equal(report.route_facts, 2);
    assert.equal(report.route_candidates, 2);
    assert.equal(report.models, 1);
    assert.equal(report.explicit_tables, 1);
    assert.equal(report.explicit_primary_keys, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Symfony local corpus scans only controller PHP files with route attributes', () => {
  const root = localRepo({
    'src/Controller/UserController.php': [
      '<?php',
      "#[Route('/api')]",
      'final class UserController {',
      "  #[Route('/users/{id}', methods: ['GET'])]",
      '  public function show() {}',
      '}',
      '',
    ].join('\n'),
    'src/Service/Other.php': '<?php class Other {}',
  });
  try {
    const report = scanT07CorpusCheckout({
      id: 'local-symfony', framework: 'symfony', owner: 'local', repo: 'symfony', ref: '0'.repeat(40),
      route_roots: ['src/Controller'], model_roots: [],
    }, root);
    assert.equal(report.route_files_considered, 1);
    assert.equal(report.route_files_with_facts, 1);
    assert.equal(report.route_facts, 2);
    assert.equal(report.route_candidates, 1);
    assert.equal(report.models, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read-set digest is deterministic and rejects malformed source identities', () => {
  const rows = [
    { path: 'config/routes.rb', sha256: 'a'.repeat(64), size_bytes: 12, roles: ['route'] },
    { path: 'app/models/widget.rb', sha256: 'b'.repeat(64), size_bytes: 23, roles: ['model'] },
  ];
  assert.equal(digestT07ReadSet(rows), digestT07ReadSet([...rows].reverse()));
  assert.throws(
    () => digestT07ReadSet([{ ...rows[0], path: '../routes.rb' }]),
    /invalid T07 read-set entry/,
  );
});

test('analysis binding digest mismatch fails before any corpus checkout', () => {
  assert.throws(
    () => runT07Corpus(MANIFEST, {
      ids: ['laravel-reference'],
      analysisBinding: {
        analyzer_commit: '0'.repeat(40),
        analyzer_source_digest_sha256: '3'.repeat(64),
        manifest_sha256: '1'.repeat(64),
        analyzer_sources: [
          { path: 'scanners/language/ruby-php/corpus.mjs', sha256: '2'.repeat(64), size_bytes: 1 },
        ],
      },
    }),
    /analyzer source digest mismatch/,
  );
});

test('selected corpus ids are checked before any checkout starts', () => {
  assert.throws(
    () => runT07Corpus(MANIFEST, { ids: ['does-not-exist'] }),
    /unknown corpus entry/,
  );
});


test('observed real-repo snapshot matches pinned manifest refs and self-consistent aggregates', () => {
  const observed = JSON.parse(
    fs.readFileSync(path.join(HERE, 'corpus-observed-2026-09-25.json'), 'utf8'),
  );
  assert.equal(observed.contract, 'sbf.t07-ruby-php-corpus-observation/1');
  assert.match(observed.scanner_revision, /^[0-9a-f]{40}$/);
  assert.equal(observed.environment.target_applications_executed, false);
  assert.equal(observed.results.length, MANIFEST.entries.length);

  const manifestById = new Map(MANIFEST.entries.map((entry) => [entry.id, entry]));
  for (const result of observed.results) {
    const entry = manifestById.get(result.id);
    assert.ok(entry, result.id);
    assert.equal(result.ref, entry.ref);
  }

  const sum = (field) => observed.results.reduce((total, row) => total + (row[field] ?? 0), 0);
  for (const field of [
    'route_facts',
    'literal',
    'partial',
    'unknown',
    'route_candidates',
    'route_unknowns',
    'models',
    'explicit_tables',
    'explicit_primary_keys',
    'model_unknowns',
  ]) {
    assert.equal(observed.aggregate[field], sum(field), field);
  }
  assert.equal(observed.aggregate.repositories, observed.results.length);
  assert.match(observed.scope, /not runtime-route certification/);
});
