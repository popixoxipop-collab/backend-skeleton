#!/usr/bin/env node
// Online verification of the version pins recorded in adapters/protocol-next/targets/<family>/SCOPE.json.
// Needs network access (npm registry, rfc-editor.org, raw.githubusercontent.com, api.github.com, git). Exit 0 only when every check passes.
// Usage: node test/protocol-next/tools/verify-target-pins.mjs [--family graphql|asyncapi|websocket]... [--out <result.json>]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FAMILIES = ['graphql', 'asyncapi', 'websocket'];

function parseArgs(argv) {
  const families = [];
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--family') families.push(argv[++index]);
    else if (argv[index] === '--out') out = argv[++index];
    else throw new Error('unknown argument ' + argv[index]);
  }
  for (const family of families) if (!FAMILIES.includes(family)) throw new Error('unknown family ' + family);
  return { families: families.length ? families : FAMILIES, out };
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const collapse = (text) => text.replace(/\s+/g, ' ');

async function fetchBuffer(url) {
  const headers = { 'user-agent': 'bskel-target-pin-verifier' };
  if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com/')) headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error('GET ' + url + ' -> HTTP ' + response.status);
  return Buffer.from(await response.arrayBuffer());
}

const fetchJson = async (url) => JSON.parse((await fetchBuffer(url)).toString('utf8'));
const packuments = new Map();
const tagLists = new Map();

async function packument(name) {
  if (!packuments.has(name)) packuments.set(name, fetchJson('https://registry.npmjs.org/' + name.replace('/', '%2F')));
  return packuments.get(name);
}

function remoteTags(repo) {
  if (!tagLists.has(repo)) {
    const output = execFileSync('git', ['ls-remote', '--tags', repo], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const tags = new Map();
    for (const line of output.split('\n').filter(Boolean)) {
      const [commit, ref] = line.split('\t');
      const name = ref.replace(/^refs\/tags\//, '');
      if (name.endsWith('^{}')) tags.set(name.slice(0, -3), { commit, peeled: true });
      else if (!tags.has(name)) tags.set(name, { commit, peeled: false });
    }
    tagLists.set(repo, tags);
  }
  return tagLists.get(repo);
}

const results = [];
const record = (family, pin, ok, detail) => {
  results.push({ family, pin, status: ok ? 'ok' : 'FAIL', detail });
  console.log((ok ? 'ok   ' : 'FAIL ') + family + ' ' + pin + ' ' + detail);
};

async function checkLibrary(family, pin) {
  const doc = await packument(pin.name);
  const integrity = doc.versions?.[pin.version]?.dist?.integrity;
  record(family, pin.id + ' integrity', integrity === pin.integrity, pin.name + '@' + pin.version + ' registry integrity ' + (integrity === pin.integrity ? 'matches' : 'is ' + integrity));
  if (pin.published) {
    const published = doc.time?.[pin.version];
    record(family, pin.id + ' published', published === pin.published, pin.name + '@' + pin.version + ' published ' + published);
  }
}

async function checkTag(family, pin) {
  const found = remoteTags(pin.repo).get(pin.tag);
  record(family, pin.id + ' tag', found?.commit === pin.commit, pin.repo + ' ' + pin.tag + ' -> ' + found?.commit);
  if (pin.release_name || pin.published) {
    const owner = pin.repo.replace('https://github.com/', '');
    const release = await fetchJson('https://api.github.com/repos/' + owner + '/releases/tags/' + pin.tag);
    if (pin.release_name) record(family, pin.id + ' release name', release.name === pin.release_name, 'release name ' + JSON.stringify(release.name));
    if (pin.published) record(family, pin.id + ' release published', release.published_at === pin.published, 'release published ' + release.published_at);
  }
}

async function checkDocument(family, pin) {
  if (pin.kind === 'graphql-spec') {
    await checkTag(family, { id: pin.id, repo: pin.repo, tag: pin.tag, commit: pin.commit });
    const url = 'https://raw.githubusercontent.com/graphql/graphql-spec/' + pin.commit + '/' + encodeURI(pin.path);
    const buffer = await fetchBuffer(url);
    const mentions = (buffer.toString('utf8').match(/oneOf/g) ?? []).length;
    record(family, pin.id + ' file', sha256(buffer) === pin.sha256 && buffer.length === pin.bytes, 'sha256 ' + sha256(buffer) + ' bytes ' + buffer.length);
    const blob = createHash('sha1').update('blob ' + buffer.length + '\0').update(buffer).digest('hex');
    record(family, pin.id + ' git blob', blob === pin.blob, 'git blob ' + blob);
    record(family, pin.id + ' oneOf mentions', mentions === pin.one_of_mentions, 'oneOf mentions ' + mentions);
    return;
  }
  if (pin.kind === 'rfc') {
    const text = await fetchBuffer(pin.source_url);
    record(family, pin.id + ' text', sha256(text) === pin.sha256 && text.length === pin.bytes, 'sha256 ' + sha256(text) + ' bytes ' + text.length);
    const collapsed = collapse(text.toString('utf8'));
    for (const phrase of pin.phrases) record(family, pin.id + ' clause ' + phrase.clause, collapsed.includes(phrase.text), JSON.stringify(phrase.text));
    const meta = await fetchJson(pin.metadata_url);
    const statusOk = String(meta.status ?? meta.pub_status).toUpperCase() === pin.status;
    const updatedBy = (meta.updated_by ?? []).map((entry) => String(entry).replace(/\s+/g, ''));
    record(family, pin.id + ' metadata', statusOk && String(meta.pub_date).includes(pin.pub_date) && pin.updated_by.every((entry) => updatedBy.includes(entry)),
      'status ' + (meta.status ?? meta.pub_status) + ', pub_date ' + meta.pub_date + ', updated_by ' + updatedBy.join(','));
    return;
  }
  throw new Error('unknown document kind ' + pin.kind);
}

async function main() {
  const { families, out } = parseArgs(process.argv.slice(2));
  for (const family of families) {
    const scope = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters/protocol-next/targets', family, 'SCOPE.json'), 'utf8'));
    for (const pin of scope.pins.libraries) await checkLibrary(family, pin);
    for (const pin of scope.pins.tags) await checkTag(family, pin);
    for (const pin of scope.pins.documents) await checkDocument(family, pin);
    for (const pin of scope.pins.absent_tags) {
      const present = pin.tags.filter((tag) => remoteTags(pin.repo).has(tag));
      record(family, pin.id, present.length === 0, pin.repo + ' has no tag among ' + pin.tags.join(',') + (present.length ? ' (present: ' + present.join(',') + ')' : ''));
    }
  }
  const failed = results.filter((entry) => entry.status !== 'ok').length;
  const summary = { run_on: new Date().toISOString().slice(0, 10), node: process.version, families, checks: results, failed };
  if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
  console.log(results.length + ' checks, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verification could not run: ' + error.message);
  process.exit(2);
});
