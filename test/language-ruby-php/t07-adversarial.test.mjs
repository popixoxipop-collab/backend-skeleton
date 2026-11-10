import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  extractRailsDslFacts,
  extractLaravelDslFacts,
  extractSymfonyRouteAttributeFacts,
} from '../../scanners/language/ruby-php/dsl-facts.mjs';
import { scanT07CorpusCheckout } from '../../scanners/language/ruby-php/corpus.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('T07 source identities are byte-bound and repository-relative for Ruby and PHP', () => {
  const cases = [
    [extractRailsDslFacts, 'resources :accounts\n', 'config/routes.rb'],
    [extractLaravelDslFacts, "<?php\nRoute::get('/accounts', fn () => null);\n", 'routes/api.php'],
    [extractSymfonyRouteAttributeFacts, "<?php\n#[Route('/accounts', methods: ['GET'])]\nclass Accounts {}\n", 'src/Controller/Accounts.php'],
  ];
  for (const [extract, source, file] of cases) {
    const report = extract(source, { file });
    assert.equal(report.source.sha256, sha256(source));
    assert.ok(report.facts.length > 0, file);
    for (const fact of report.facts) {
      assert.equal(fact.source.file, file);
      assert.equal(fact.source.sha256, sha256(source.slice(fact.source.start, fact.source.end)));
    }
    for (const unsafe of ['../outside.php', 'routes/../../outside.php', '/tmp/outside.php']) {
      assert.throws(() => extract(source, { file: unsafe }), /repository root|repository-relative/);
    }
  }
});

test('T07 Rails and Laravel dynamic parents never produce literal child routes', () => {
  const rails = extractRailsDslFacts([
    'Rails.application.routes.draw do',
    '  namespace "#{tenant}" do',
    '    resources :accounts',
    '  end',
    'end',
  ].join('\n'));
  const resource = rails.facts.find((fact) => fact.kind === 'resource');
  assert.equal(resource.status, 'unknown');
  assert.match(resource.unknownReason, /dynamic/);

  const laravel = extractLaravelDslFacts([
    '<?php',
    "Route::prefix(config('tenant.prefix'))->group(function () {",
    "  Route::get('/accounts', fn () => null);",
    '});',
  ].join('\n'));
  const route = laravel.facts.find((fact) => fact.kind === 'route');
  assert.equal(route.status, 'unknown');
  assert.match(route.unknownReason, /dynamic/);
});

test('T07 PHP attribute profiles keep finite methods and dynamic paths distinct', () => {
  // These are static PHP 8 attribute-source fixtures, not a PHP runtime comparison.
  const source = [
    '<?php',
    "#[Route('/v1/accounts', methods: ['GET', 'HEAD'])]",
    'public function list() {}',
    "#[Route($tenantPath, methods: ['GET'])]",
    'public function dynamic() {}',
  ].join('\n');
  const report = extractSymfonyRouteAttributeFacts(source);
  const literal = report.facts.find((fact) => fact.status === 'literal');
  const unknown = report.facts.find((fact) => fact.status === 'unknown');
  assert.deepEqual(literal.attributes.methods, ['GET', 'HEAD']);
  assert.equal(unknown.kind, 'attribute');
  assert.match(unknown.unknownReason, /path/);
});

test('T07 corpus source permission denial fails closed before a route result is returned',
  { skip: process.getuid?.() === 0 && 'mode 000 is ineffective for root' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t07-permission-'));
    const file = path.join(root, 'config/routes.rb');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'resources :accounts\n');
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      execFileSync('git', ['add', 'config/routes.rb'], { cwd: root });
      fs.chmodSync(file, 0);
      assert.throws(() => scanT07CorpusCheckout({
        id: 'permission', framework: 'rails', owner: 'local', repo: 'rails', ref: '0'.repeat(40),
        route_roots: ['config'], model_roots: [],
      }, root), (error) => error?.code === 'EACCES');
    } finally {
      fs.chmodSync(file, 0o644);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test('T07 Rails fixture syntax is accepted by distinct Ruby 2.6 and 4.0 interpreters',
  { skip: !fs.existsSync('/usr/bin/ruby') || !fs.existsSync('/opt/homebrew/bin/ruby')
    ? 'two Ruby interpreter lines are not installed on this host' : false }, () => {
    const source = 'Rails.application.routes.draw do\n  resources :accounts\nend\n';
    const versions = [];
    for (const binary of ['/usr/bin/ruby', '/opt/homebrew/bin/ruby']) {
      const version = spawnSync(binary, ['-v'], { encoding: 'utf8' });
      assert.equal(version.status, 0, binary);
      versions.push(version.stdout.trim());
      const syntax = spawnSync(binary, ['-c'], { input: source, encoding: 'utf8' });
      assert.equal(syntax.status, 0, `${binary}: ${syntax.stderr}`);
      assert.match(syntax.stdout, /Syntax OK/);
    }
    assert.match(versions[0], /ruby 2\.6\./);
    assert.match(versions[1], /ruby 4\.0\./);
    const facts = extractRailsDslFacts(source);
    assert.equal(facts.facts.find((fact) => fact.kind === 'resource').status, 'literal');
  });
