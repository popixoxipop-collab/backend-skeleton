import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScan } from '../../scanners/index.mjs';
import { adapter as railsAdapter } from '../../scanners/adapters/ruby-rails.mjs';
import { parseRailsExpandedRoutes } from '../../scanners/language/ruby-php/runtime-route-snapshot.mjs';

function routeKeys(routes) {
  return routes.map((route) => `${route.method ?? route.verb} ${route.path}`).sort();
}

test('T07 Rails runtime snapshot parser matches the stable adapter runtime surface format', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t07-runtime-parity-'));
  try {
    fs.writeFileSync(path.join(root, 'Gemfile'), 'gem "rails", "~> 8.1"\n');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'application.rb'), 'module App; class Application < Rails::Application; end; end\n');
    fs.writeFileSync(path.join(root, 'config', 'routes.rb'), 'Rails.application.routes.draw do\nend\n');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });

    const raw = [
      '--[ Route 1 ]----------------------------------------------------',
      'Prefix            | api_article',
      'Verb              | GET',
      'URI               | /api/articles/:id(.:format)',
      'Controller#Action | api/articles#show',
      `Source Location   | ${path.join(root, 'config', 'routes.rb')}:2`,
      '--[ Route 2 ]----------------------------------------------------',
      'Prefix            | health',
      'Verb              | GET',
      'URI               | /health(.:format)',
      'Controller#Action | health#show',
      `Source Location   | ${path.join(root, 'config', 'routes.rb')}:3`,
      '',
    ].join('\n');

    const bin = path.join(root, 'bin', 'rails');
    fs.writeFileSync(bin, `#!/bin/sh\ncat <<'OUT'\n${raw}OUT\n`);
    fs.chmodSync(bin, 0o755);

    const stable = runScan({
      repoRoot: root,
      terms: [],
      adapters: [railsAdapter],
      runtimeRoutes: true,
    });
    assert.equal(stable.runtime_introspection?.status, 'used');

    const stableRoutes = stable.related_modules
      .flatMap((module) => module.controllers ?? [])
      .flatMap((controller) => controller.endpoints ?? []);

    const t07 = parseRailsExpandedRoutes(raw);
    assert.deepEqual(routeKeys(t07.routes), routeKeys(stableRoutes));
    assert.equal(t07.unknowns.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
