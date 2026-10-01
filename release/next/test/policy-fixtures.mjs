// Shared, hermetic fixtures for the release-policy forgery-resistance tests. Not a test file itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RELEASE_DIR = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(RELEASE_DIR, '..', '..');
export const INVENTORY_PATH = path.join(RELEASE_DIR, 'compatibility-inventory.json');
export const PLAN_PATH = path.join(RELEASE_DIR, 'release-plan.json');
export const MANIFEST_PATH = path.join(RELEASE_DIR, 'evidence-manifest.json');
export const ROLES = ['bskel', 'becoder', 'beval'];
export const IDENTITY_PACK = 'schemas/next/identity-conformance.json';

export const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
export const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
export const clone = (x) => structuredClone(x);
export const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const IDENTITY_PACK_SHA256 = sha256Hex(fs.readFileSync(path.join(REPO_ROOT, IDENTITY_PACK)));

export const repoOf = (inv, role) => inv.repositories.find((r) => r.role === role);

export function goodRun(inv, role) {
  const repo = repoOf(inv, role);
  return {
    id: repo.verification.ci_run,
    repository: { full_name: repo.repo },
    event: 'push',
    head_branch: 'main',
    head_sha: repo.verification.ci_head_sha,
    status: 'completed',
    conclusion: 'success',
  };
}

// fetchRun double for verifyOnline: reply(request, role) returns {status, body}, or throws.
export function scriptedFetchRun(inv, reply = (_req, role) => ({ status: 200, body: goodRun(inv, role) })) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const role = inv.repositories.find((r) => r.repo === request.repo)?.role;
    return reply(request, role);
  };
  fn.calls = calls;
  return fn;
}

const RUN_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/;

// global-fetch double for runCli. `truth` plays GitHub: GET repos/<repo>/actions/runs/<id> answers the good run
// when <repo>/<id> is a pinned run of `truth` and 404 otherwise. overrides[role] is {status, body} or {throw: Error}
// and replaces the answer for that role's repository whatever the id is.
export function fakeGithubFetch(truth, overrides = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const match = RUN_URL.exec(String(url));
    const entry = match ? truth.repositories.find((r) => r.repo === match[1]) : undefined;
    const role = entry?.role;
    const exists = entry !== undefined && String(entry.verification.ci_run) === match[2];
    const override = overrides[role];
    if (override?.throw) throw override.throw;
    const status = override?.status ?? (exists ? 200 : 404);
    const body = override && 'body' in override ? override.body : exists ? goodRun(truth, role) : { message: 'Not Found' };
    if (status === 204 || status === 304 || (status >= 300 && status < 400)) return new Response(null, { status });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

export function capture() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => { out.push(String(s)); return true; } },
    stderr: { write: (s) => { err.push(String(s)); return true; } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

export function tempRoot(t, { withPack = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (withPack) {
    fs.mkdirSync(path.join(root, 'schemas', 'next'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, IDENTITY_PACK), path.join(root, IDENTITY_PACK));
  }
  return root;
}

export const fileRef = (p = IDENTITY_PACK, sha256 = IDENTITY_PACK_SHA256) => ({ kind: 'file', path: p, sha256 });

export const WAIVER = Object.freeze({
  id: 'WAIVER-test-1',
  approved_by: 'release-owner',
  approved_on: '2026-10-01',
  scope: 'promotion_evidence.t19_03',
  reason: 'independent QA deferred for the candidate-prefreeze rehearsal',
});
export const waiverRef = (overrides = {}) => ({ kind: 'waiver', waiver: { ...WAIVER, ...overrides } });

export function accept(inv, key, ref) {
  const x = clone(inv);
  x.promotion_evidence[key].observed_state = 'ACCEPTED';
  if (ref === undefined) delete x.promotion_evidence[key].evidence_ref;
  else x.promotion_evidence[key].evidence_ref = ref;
  return x;
}

export const codes = (result) => result.errors.map((e) => e.code);
