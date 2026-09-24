import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '..', '..', '..');
const source = path.join(root, 'src', 'index.html');
const threeSource = path.join(repoRoot, 'node_modules', 'three', 'build', 'three.module.js');
const threeCoreSource = path.join(repoRoot, 'node_modules', 'three', 'build', 'three.core.js');
const output = path.join(root, 'dist');
if (!fs.existsSync(threeSource)) throw new Error('three.module.js is unavailable; install the approved local Three.js dependency');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'vendor'), { recursive: true });
fs.copyFileSync(source, path.join(output, 'index.html'));
fs.copyFileSync(threeSource, path.join(output, 'vendor', 'three.module.js'));
if (fs.existsSync(threeCoreSource)) fs.copyFileSync(threeCoreSource, path.join(output, 'vendor', 'three.core.js'));
