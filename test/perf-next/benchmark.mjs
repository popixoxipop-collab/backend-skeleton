import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildFileIndex } from '../../lib/scan-scheduler-next/file-index.mjs';

function parsePositiveInt(flag, fallback) {
	const index = process.argv.indexOf(flag);
	if (index === -1) return fallback;
	const n = Number(process.argv[index + 1]);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} requires a positive integer`);
	return n;
}

const files = parsePositiveInt('--files', 100);
const bytesPerFile = parsePositiveInt('--bytes-per-file', 256);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-bench-'));
const src = path.join(root, 'src');
fs.mkdirSync(src, { recursive: true });
const payload = 'x'.repeat(Math.max(0, bytesPerFile - 32));
for (let i = 0; i < files; i++) {
	const bucket = path.join(src, String(Math.floor(i / 1000)).padStart(4, '0'));
	fs.mkdirSync(bucket, { recursive: true });
	fs.writeFileSync(path.join(bucket, `file-${String(i).padStart(6, '0')}.js`), `export const n${i}=${i};/*${payload}*/\n`);
}

function measure(label) {
	const rssBefore = process.memoryUsage().rss;
	const start = performance.now();
	const index = buildFileIndex(root, { maxFiles: Math.max(files + 10, 1_000), maxBytes: Math.max(files * bytesPerFile * 4, 64 * 1024 * 1024) });
	const elapsedMs = performance.now() - start;
	const rssAfter = process.memoryUsage().rss;
	return { label, elapsed_ms: Number(elapsedMs.toFixed(3)), rss_before: rssBefore, rss_after: rssAfter, rss_delta: rssAfter - rssBefore, files: index.stats.files, bytes: index.stats.bytes, source_digest: index.source_digest };
}

const cold = measure('cold-process-first-pass');
const warm = measure('same-process-second-pass-no-cache-yet');
console.log(JSON.stringify({ schema: 'sbf.t21-benchmark/1', workload: { files, bytes_per_file: bytesPerFile }, cold, warm, note: 'measurement harness only; no SLO claim and no persistent cache is wired into stable scan yet' }, null, 2));
fs.rmSync(root, { recursive: true, force: true });
