import path from 'node:path';
import { parseSourceFile } from './javascript.mjs';
import { parseSvelteSource } from './svelte.mjs';

const SUPPORTED = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.svelte']);

export function isSupportedWebgameSource(filePath) {
  return SUPPORTED.has(path.extname(filePath).toLowerCase());
}

export function parseWebgameSource({ sourcePath, text, role = 'active' }) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.svelte') return parseSvelteSource(text, { sourcePath, role });
  return parseSourceFile({ sourcePath, text, role, language: ext.slice(1) });
}
