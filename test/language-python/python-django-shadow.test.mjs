import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFiles, findPythonRuntime } from '../../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts } from '../../scanners/language/python/resolver.mjs';
import { buildDjangoUrlShadow } from '../../scanners/language/python/django-shadow.mjs';

const runtime = findPythonRuntime();

function project(root, files) {
  const batch = analyzePythonFiles({ repoRoot: root, files });
  assert.equal(batch.ok, true, JSON.stringify(batch, null, 2));
  return buildPythonProjectFacts(batch.results);
}

test('T06 Django shadow expands literal include() prefixes without inventing HTTP methods', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-django-shadow-'));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'app', 'views.py'), `
def health(request):
    pass

def item_list(request):
    pass
`);
  fs.writeFileSync(path.join(root, 'app', 'api_urls.py'), `
from django.urls import path
from .views import item_list
urlpatterns = [path("items/", item_list, name="item-list")]
`);
  fs.writeFileSync(path.join(root, 'app', 'urls.py'), `
from django.urls import include, path
from .views import health
urlpatterns = [
    path("health/", health, name="health"),
    path("api/", include("app.api_urls")),
]
`);
  const shadow = buildDjangoUrlShadow(project(root, ['app/__init__.py', 'app/views.py', 'app/api_urls.py', 'app/urls.py']));
  assert.equal(shadow.unknowns.length, 0, JSON.stringify(shadow, null, 2));
  assert.equal(shadow.registrations.length, 2, JSON.stringify(shadow, null, 2));
  const byName = Object.fromEntries(shadow.registrations.map((x) => [x.name, x]));
  assert.deepEqual(byName.health.patternSegments, [{ kind: 'path', value: 'health/' }]);
  assert.deepEqual(byName['item-list'].patternSegments, [{ kind: 'path', value: 'api/' }, { kind: 'path', value: 'items/' }]);
  assert.equal(byName.health.target.module, 'app.views');
  assert.equal(byName.health.target.name, 'health');
  assert.equal(byName.health.methodSemantics, 'not-declared-by-urlconf');
  assert.equal('methods' in byName.health, false, 'URLConf analysis must not invent request-method semantics');
});

test('T06 Django shadow preserves dynamic URL patterns and include targets as unknown', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-django-unknown-'));
  fs.writeFileSync(path.join(root, 'urls.py'), `
from django.urls import include, path
PREFIX = make_prefix()
urlpatterns = [
    path(PREFIX, handler),
    path("nested/", include(router.urls)),
]
`);
  const shadow = buildDjangoUrlShadow(project(root, ['urls.py']));
  assert.equal(shadow.registrations.length, 0);
  assert.ok(shadow.unknowns.some((x) => x.reason === 'route-pattern-not-literal'));
  assert.ok(shadow.unknowns.some((x) => x.reason === 'include-target-not-literal-module'));
});

test('T06 Django shadow recognizes local class-based as_view() without executing it', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-django-cbv-'));
  fs.writeFileSync(path.join(root, 'urls.py'), `
from django.urls import path
class StatusView:
    @classmethod
    def as_view(cls):
        raise RuntimeError("must never execute")
urlpatterns = [path("status/", StatusView.as_view(), name="status")]
`);
  const shadow = buildDjangoUrlShadow(project(root, ['urls.py']));
  assert.equal(shadow.unknowns.length, 0, JSON.stringify(shadow, null, 2));
  assert.deepEqual(shadow.registrations[0].target, {
    kind: 'class-view', locality: 'local', module: 'urls', name: 'StatusView', factory: 'as_view', raw: 'StatusView.as_view',
  });
});
