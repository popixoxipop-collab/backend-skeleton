import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanWebgame } from '../scanners/webgame.mjs';
import { analyzeWebgameJsTsShadow } from '../scanners/language/js-ts/webgame-shadow.mjs';

function root(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(base, relative, text) {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function buildR3fRepo() {
  const repo = root('bskel-t04-r3f-shadow-');
  write(repo, 'package.json', JSON.stringify({
    private: true,
    dependencies: {
      three: '^0.180.0',
      '@react-three/fiber': '^9.0.0',
    },
  }, null, 2));
  write(repo, 'src/App.tsx', `
import { Canvas } from '@react-three/fiber';
import Player from './Player';
export function App() {
  return <Canvas><Player /></Canvas>;
}
`);
  write(repo, 'src/Player.tsx', `
import { useFrame } from '@react-three/fiber';
export default function Player() {
  useFrame(() => {});
  return <mesh name="player" />;
}
`);
  return repo;
}

test('R3F webgame evidence can be shadowed without changing the existing webgame scan', () => {
  const repo = buildR3fRepo();
  const before = scanWebgame(repo);
  assert.ok(before.engines.includes('@react-three/fiber'));

  const shadow = analyzeWebgameJsTsShadow(repo);
  assert.equal(shadow.detected, true);
  assert.equal(shadow.webgameAdapter, before.adapter);
  assert.equal(shadow.webgameSourceHash, before.source_hash);
  assert.ok(shadow.filesRead.includes('src/App.tsx'));
  assert.ok(shadow.filesRead.includes('src/Player.tsx'));
  assert.ok(shadow.skippedFiles.includes('package.json'));
  assert.equal(shadow.snapshot.complete, true);
  assert.equal(shadow.snapshot.syntaxValidated, false);

  const player = shadow.snapshot.moduleGraph.find((edge) => edge.specifier === './Player');
  assert.ok(player);
  assert.equal(player.status, 'resolved');
  assert.equal(player.target, 'src/Player.tsx');

  const r3f = shadow.snapshot.moduleGraph.filter((edge) => edge.specifier === '@react-three/fiber');
  assert.equal(r3f.length, 2);
  assert.ok(r3f.every((edge) => edge.status === 'bare'));

  const after = scanWebgame(repo);
  assert.deepEqual(after, before);
});

test('webgame repo with engine but no JS/TS source yields no fabricated graph', () => {
  const repo = root('bskel-t04-r3f-empty-');
  write(repo, 'package.json', JSON.stringify({
    dependencies: { three: '^0.180.0' },
  }));
  const shadow = analyzeWebgameJsTsShadow(repo);
  assert.equal(shadow.detected, true);
  assert.equal(shadow.snapshot, null);
});

test('repo without a supported webgame engine stays detected=false and snapshot=null', () => {
  const repo = root('bskel-t04-r3f-none-');
  write(repo, 'package.json', JSON.stringify({
    dependencies: { react: '^19.0.0' },
  }));
  write(repo, 'src/App.tsx', 'export const App = () => null;');
  const shadow = analyzeWebgameJsTsShadow(repo);
  assert.equal(shadow.detected, false);
  assert.equal(shadow.snapshot, null);
});

test('shadow read budget fails closed without a partial module graph', () => {
  const repo = buildR3fRepo();
  const shadow = analyzeWebgameJsTsShadow(repo, { maxReadBytes: 1 });
  assert.equal(shadow.detected, true);
  assert.equal(shadow.snapshot.complete, false);
  assert.equal(shadow.snapshot.allResolved, false);
  assert.equal(shadow.snapshot.syntaxValidated, false);
  assert.deepEqual(shadow.snapshot.files, []);
  assert.deepEqual(shadow.snapshot.moduleGraph, []);
  assert.equal(shadow.snapshot.diagnostics[0].code, 'webgame-shadow-read-limit');
});
