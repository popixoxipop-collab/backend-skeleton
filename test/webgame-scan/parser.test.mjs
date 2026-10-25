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

test('long multiline imports are not truncated before the module specifier', () => {
  const parsed = parseJavaScriptSource(`import {
    Scene, PerspectiveCamera, WebGPURenderer, Color, Vector2, Vector3, Mesh, MathUtils,
    NeutralToneMapping, Matrix4, Quaternion, Euler, Box3, Sphere, Raycaster
  } from 'three/webgpu';`, { sourcePath: 'src/main.js' });
  assert.ok(parsed.imports.some((x) => x.specifier === 'three/webgpu'));
});

test('template interpolations are not silently treated as inert text', () => {
  const parsed = parseJavaScriptSource('const label = \`scene: ${buildScene()}\`;', { sourcePath: 'src/template.ts' });
  assert.ok(parsed.unresolved.some((x) => x.kind === 'template-expression'));
});

test('constructor assignment binding is captured for renderer correlation', () => {
  const parsed = parseJavaScriptSource('const renderer: THREE.WebGLRenderer = new WebGLRenderer(); this.alt = new THREE.WebGPURenderer();', { sourcePath: 'src/main.ts' });
  assert.equal(parsed.constructions.find((x) => x.name === 'WebGLRenderer')?.binding, 'renderer');
  assert.equal(parsed.constructions.find((x) => x.name === 'THREE.WebGPURenderer')?.binding, 'this.alt');
});

test('import bindings preserve aliases, namespaces, and type-only metadata', () => {
  const parsed = parseJavaScriptSource(`
    import * as THREE from 'three';
    import { WebGLRenderer as Renderer, type Camera } from 'three';
    import type { Scene as SceneType } from 'three';
  `, { sourcePath: 'src/imports.ts' });
  const [namespaceImport, namedImport, typeImport] = parsed.imports;
  assert.deepEqual(namespaceImport.bindings, [{ kind: 'namespace', imported: '*', local: 'THREE', type_only: false }]);
  assert.ok(namedImport.bindings.some((b) => b.imported === 'WebGLRenderer' && b.local === 'Renderer' && b.type_only === false));
  assert.ok(namedImport.bindings.some((b) => b.imported === 'Camera' && b.local === 'Camera' && b.type_only === true));
  assert.equal(typeImport.type_only, true);
  assert.ok(typeImport.bindings.every((b) => b.type_only));
});

test('Svelte script-like text inside an HTML comment is inert', () => {
  const parsed = parseSvelteSource(`<!-- <script>const renderer = new WebGLRenderer();</script> -->\n<p>docs</p>`, { sourcePath: 'src/Commented.svelte' });
  assert.equal(parsed.constructions.length, 0);
  assert.equal(parsed.imports.length, 0);
});

test('regex literal text cannot manufacture Three.js runtime evidence', () => {
  const parsed = parseJavaScriptSource(`const docs = /new Scene\\(\\).*renderer\\.render\\(scene, camera\\)/g;`, { sourcePath: 'src/regex.ts' });
  assert.equal(parsed.constructions.length, 0);
  assert.equal(parsed.calls.some((x) => x.name.endsWith('.render')), false);
});

test('unclosed Svelte HTML comment keeps fake script inert and reports unresolved syntax', () => {
  const parsed = parseSvelteSource(`<!-- docs <script>const renderer = new WebGLRenderer();</script>`, { sourcePath: 'src/Unclosed.svelte' });
  assert.equal(parsed.constructions.length, 0);
  assert.ok(parsed.unresolved.some((x) => x.kind === 'syntax' && /unclosed HTML comment/.test(x.message)));
});
