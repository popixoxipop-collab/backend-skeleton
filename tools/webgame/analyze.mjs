import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanMultiplane } from '../../scanners/multiplane.mjs';

export function analyzeWebgameRepository(repoRoot) {
  return scanMultiplane({ repoRoot });
}

function main(argv) {
  const args = [...argv];
  let repoRoot = '.';
  let output = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') repoRoot = args[++i];
    else if (args[i] === '--output') output = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write('Usage: node tools/webgame/analyze.mjs [--repo PATH] [--output FILE]\n');
      return 0;
    } else throw new Error(`unknown argument: ${args[i]}`);
  }
  const report = analyzeWebgameRepository(path.resolve(repoRoot));
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), json);
  } else process.stdout.write(json);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (err) { process.stderr.write(`${err.stack ?? err.message}\n`); process.exitCode = 1; }
}
