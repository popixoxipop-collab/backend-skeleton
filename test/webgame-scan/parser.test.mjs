import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJavaScriptSource } from '../../tools/webgame/parsers/javascript.mjs';
import { parseSvelteSource } from '../../tools/webgame/parsers/svelte.mjs';

test('comments and template strings do not become executable Three.js evidence', () => {
  const parsed = parseJavaScriptSource(`
    // new Scene();
    /* new WebGLRenderer(); */
    const docs = \`new Scene(); renderer.render(scene, camera)\`;
    const real = new Worker('worker.js');
  `, { sourcePath: 'src/example.ts' });
  assert.deepEqual(parsed.constructions.map((x) => x.name), ['Worker']);
  assert.equal(parsed.calls.some((x) => x.name.endsWith('.render')), false);
});

test('dynamic import with a non-literal target is explicit unresolved evidence', () => {
  const parsed = parseJavaScriptSource('const m = await import(moduleName);', { sourcePath: 'src/dynamic.ts' });
  assert.equal(parsed.dynamicImports.length, 1);
  assert.equal(parsed.dynamicImports[0].literal, false);
  assert.ok(parsed.unresolved.some((x) => x.kind === 'dynamic-import'));
});

test('Svelte script evidence keeps coordinates in the original .svelte file', () => {
  const source = `<h1>demo</h1>\n<script lang="ts">\n  import { Scene } from 'three';\n  const scene = new Scene();\n</script>`;
  const parsed = parseSvelteSource(source, { sourcePath: 'src/Scene.svelte' });
  const scene = parsed.constructions.find((x) => x.name === 'Scene');
  assert.ok(scene);
  assert.equal(scene.source_path, 'src/Scene.svelte');
  assert.equal(scene.line, 4);
  assert.ok(scene.column > 1);
});

test('basic delimiter damage is reported instead of silently disappearing', () => {
  const parsed = parseJavaScriptSource('function broken() { return 1;', { sourcePath: 'src/broken.ts' });
  assert.ok(parsed.unresolved.some((x) => x.kind === 'syntax' && /unclosed/.test(x.message)));
});
