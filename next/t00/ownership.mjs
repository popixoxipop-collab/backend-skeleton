// T00-02 ownership model: scope grammar, overlap, owner lookup and the checks over a map. Pure functions: nothing here
// reads a file, starts a process or touches the network, and no JSON value given as the map makes them throw (a map
// of the wrong shape is reported as MAP_SCHEMA).

export const MAP_SCHEMA = 'bskel.t00-ownership-map/1';
export const MAP_CODES = ['MAP_SCHEMA', 'DUPLICATE_TRACK', 'INVALID_SCOPE', 'SCOPE_COLLISION', 'HOT_PATH_MISSING', 'HOT_PATH_CLAIMED', 'PLAN_SCOPE_MISMATCH', 'SUITE_UNKNOWN_TRACK', 'SUITE_SCOPE_MISSING'];
export const PATH_CODES = ['UNKNOWN_TRACK', 'INVALID_PATH', 'PATH_OWNED_BY_OTHER_TRACK', 'PATH_RESERVED_HOT', 'PATH_CASE_MISMATCH', 'PATH_UNOWNED'];
export const T00_TEST_FILE = /^test\/t00-[a-z0-9-]+\.test\.mjs$/;
export const TRACK_ID = /^T\d\d$/;
export const SCOPE_KEYS = ['plan_scopes', 'suite_scopes', 'extra_scopes'];

const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
export const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
export const isText = (x) => typeof x === 'string' && x !== '';
export const isTexts = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string');
export const matches = (re, x) => typeof x === 'string' && re.test(x);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const sortedObject = (o) => (isObject(o) ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : o);
const errorText = (e) => `${e.code} ${e.subject} ${e.detail}`;
// Code-unit order, so the order of the lines does not depend on the locale of the machine that prints them.
export const sortErrors = (errors) => errors.sort((a, b) => (errorText(a) < errorText(b) ? -1 : errorText(a) > errorText(b) ? 1 : 0));
// One error as one output line. Control characters are escaped so that a file name cannot add a line of its own.
export const formatError = (e) => `FAIL ${errorText(e)}`.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

// A scope is a repository-relative path with forward slashes: an exact file, or a directory written with a trailing /**.
export function parseScope(scope) {
  if (typeof scope !== 'string' || scope === '') throw new Error('empty scope');
  if (scope.includes('\\')) throw new Error('backslash is not allowed');
  const dir = scope.endsWith('/**');
  const parts = (dir ? scope.slice(0, -3) : scope).split('/');
  for (const part of parts) {
    if (part === '') throw new Error('empty path segment (absolute path, double slash or a lone /**)');
    if (part === '.' || part === '..') throw new Error('dot segments are not allowed');
    if (!SEGMENT.test(part)) throw new Error(`segment "${part}" is outside [A-Za-z0-9._@+-]; only a trailing /** may be a glob`);
  }
  return { path: parts.join('/'), dir };
}

// '' when the scope is valid, otherwise the reason.
export function scopeProblem(scope) {
  try {
    parseScope(scope);
    return '';
  } catch (e) {
    return e.message;
  }
}

// A path to check. Typed by a person, Windows separators are converted; taken from git (backslash 'reject') a backslash is
// part of a file name and the path is refused, because converting it would make a file in the repository root look like a
// file in a directory.
export function normalizePath(raw, { backslash = 'convert' } = {}) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) throw new Error('empty path');
  if (backslash === 'reject' && raw.includes('\\')) throw new Error('a backslash in a file name is not allowed');
  let p = raw.replaceAll('\\', '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error('absolute paths are not allowed');
  const parts = p.split('/');
  if (parts.includes('..')) throw new Error('path traversal is not allowed');
  if (parts.some((part) => part === '' || part === '.')) throw new Error('empty or dot path segment');
  return p;
}

export function scopeCoversPath(scope, p, { fold = false } = {}) {
  const s = parseScope(scope);
  const base = fold ? s.path.toLowerCase() : s.path;
  const target = fold ? p.toLowerCase() : p;
  return s.dir ? target.startsWith(`${base}/`) : target === base;
}

// Overlap is judged case-insensitively: on macOS and Windows two scopes that differ only in case are one directory.
export function scopesOverlap(a, b) {
  const x = parseScope(a);
  const y = parseScope(b);
  const px = x.path.toLowerCase();
  const py = y.path.toLowerCase();
  if (x.dir && y.dir) return px === py || px.startsWith(`${py}/`) || py.startsWith(`${px}/`);
  if (x.dir) return py.startsWith(`${px}/`);
  if (y.dir) return px.startsWith(`${py}/`);
  return px === py;
}

// Sorted, without duplicates and without scopes that a broader directory scope of the same list already covers.
export function normalizeScopes(list) {
  const parsed = [...new Set(list)].map((s) => ({ s, ...parseScope(s) }));
  return parsed.filter((a) => !parsed.some((b) => b !== a && b.dir && a.path.startsWith(`${b.path}/`))).map((x) => x.s).sort();
}

export function suiteEntry(suite) {
  const uniq = (xs) => [...new Set(xs)].sort();
  return {
    id: suite.id,
    source_paths: uniq(suite.sourcePaths ?? []),
    test_dirs: uniq([...(suite.testDir ? [suite.testDir] : []), ...(suite.testDirs ?? []), ...(suite.requiredTestDirs ?? [])]),
  };
}

export const suiteScopes = (entry) => normalizeScopes([...entry.source_paths, ...entry.test_dirs].map((d) => `${d}/**`));

const extraAllowed = (t, s) => t.track === 'T00' && T00_TEST_FILE.test(s);
const ownedScopes = (t) => normalizeScopes([...t.plan_scopes, ...t.suite_scopes, ...t.extra_scopes.filter((s) => extraAllowed(t, s))].filter((s) => !scopeProblem(s)));

function shapeProblems(map, expectedRepositories) {
  if (!isObject(map)) return ['the map is not an object'];
  const problems = [];
  if (map.schema !== MAP_SCHEMA) problems.push(`schema is not ${MAP_SCHEMA}`);
  const repos = isObject(map.repositories) && Object.values(map.repositories).every(isText) ? map.repositories : null;
  if (repos === null) problems.push('repositories is not an object of role to repository name');
  if (expectedRepositories && !sameJson(sortedObject(map.repositories), sortedObject(expectedRepositories))) problems.push('repositories differ from the baseline lock (role to repository name)');
  const known = (role) => repos !== null && typeof role === 'string' && Object.hasOwn(repos, role);
  if (!Array.isArray(map.tracks) || map.tracks.length === 0) problems.push('tracks is not a non-empty array');
  for (const t of Array.isArray(map.tracks) ? map.tracks : []) {
    if (!isObject(t)) {
      problems.push('a tracks entry is not an object');
      continue;
    }
    if (!matches(TRACK_ID, t.track)) problems.push(`track id ${JSON.stringify(t.track)} is not Tnn`);
    if (!known(t.repository)) problems.push(`track ${t.track}: repository ${JSON.stringify(t.repository)} is not a listed role`);
    for (const key of SCOPE_KEYS) if (!isTexts(t[key])) problems.push(`track ${t.track}: ${key} is not an array of strings`);
  }
  if (!Array.isArray(map.reserved_hot_paths) || map.reserved_hot_paths.some((h) => !isObject(h) || !known(h.repository) || !isText(h.path) || !isText(h.reason))) {
    problems.push('reserved_hot_paths is not an array of {repository, path, reason}');
  }
  if (!Array.isArray(map.limits) || map.limits.length === 0 || !map.limits.every(isText)) problems.push('limits is not a non-empty array of statements');
  return problems;
}

// ctx: repositories (role to name, from the baseline lock), plan ([{track, repository, write_scopes}]), suites (suite
// entries), suiteRepository (role the nested runner belongs to, default bskel) and pathExists(role, path) -> boolean.
// A part that is not given is not checked, so the caller states exactly what it verified.
export function checkMap(map, ctx = {}) {
  const problems = shapeProblems(map, ctx.repositories);
  if (problems.length) return sortErrors(problems.map((detail) => ({ code: 'MAP_SCHEMA', subject: 'map', detail })));
  const errors = [];
  const fail = (code, subject, detail) => errors.push({ code, subject, detail });

  const seen = new Set();
  for (const t of map.tracks) {
    if (seen.has(t.track)) fail('DUPLICATE_TRACK', t.track, 'the track appears more than once in tracks');
    seen.add(t.track);
  }

  const owned = []; // {track, repository, scope}: only scopes that passed the grammar check, so one bad scope reports once
  const scopesOfTrack = new Map();
  for (const t of map.tracks) {
    for (const key of SCOPE_KEYS) {
      for (const s of t[key]) {
        const problem = scopeProblem(s) || (key === 'extra_scopes' && !extraAllowed(t, s) ? 'extra scopes are only for T00 test files test/t00-*.test.mjs' : '');
        if (problem) fail('INVALID_SCOPE', t.track, `${key}: ${JSON.stringify(s)}: ${problem}`);
      }
    }
    const scopes = ownedScopes(t);
    scopesOfTrack.set(t.track, [...(scopesOfTrack.get(t.track) ?? []), ...scopes]);
    for (const scope of scopes) owned.push({ track: t.track, repository: t.repository, scope });
  }

  for (let i = 0; i < owned.length; i += 1) {
    for (let j = i + 1; j < owned.length; j += 1) {
      const a = owned[i];
      const b = owned[j];
      if (a.repository === b.repository && a.track !== b.track && scopesOverlap(a.scope, b.scope)) {
        fail('SCOPE_COLLISION', [a.track, b.track].sort().join('<>'), `${a.track} ${a.scope} overlaps ${b.track} ${b.scope}`);
      }
    }
  }

  for (const h of map.reserved_hot_paths) {
    const problem = scopeProblem(h.path);
    if (problem) {
      fail('INVALID_SCOPE', 'reserved_hot_paths', `${JSON.stringify(h.path)}: ${problem}`);
      continue;
    }
    const hp = parseScope(h.path).path;
    if (ctx.pathExists && !ctx.pathExists(h.repository, hp)) fail('HOT_PATH_MISSING', h.path, `${h.repository} has no ${hp}`);
    for (const o of owned) {
      if (o.repository === h.repository && scopesOverlap(o.scope, h.path)) fail('HOT_PATH_CLAIMED', o.track, `${o.scope} overlaps the reserved path ${h.path}`);
    }
  }

  if (ctx.plan) {
    const wanted = new Set(ctx.plan.map((p) => p.track));
    for (const p of ctx.plan) {
      const entries = map.tracks.filter((t) => t.track === p.track);
      if (entries.length === 0) fail('PLAN_SCOPE_MISMATCH', p.track, 'the plan has this track, the map does not');
      for (const t of entries) {
        if (t.repository !== p.repository) fail('PLAN_SCOPE_MISMATCH', p.track, `repository is ${t.repository}, the plan says ${p.repository}`);
        const have = normalizeScopes(t.plan_scopes.filter((s) => !scopeProblem(s)));
        const need = normalizeScopes(p.write_scopes);
        if (!sameJson(have, need)) fail('PLAN_SCOPE_MISMATCH', p.track, `plan_scopes lack [${need.filter((s) => !have.includes(s))}] and add [${have.filter((s) => !need.includes(s))}]`);
      }
    }
    for (const t of map.tracks) if (!wanted.has(t.track)) fail('PLAN_SCOPE_MISMATCH', t.track, 'the map has this track, the plan does not');
  }

  if (ctx.suites) {
    const suiteRepository = ctx.suiteRepository ?? 'bskel';
    for (const entry of ctx.suites) {
      if (!map.tracks.some((t) => t.track === entry.id && t.repository === suiteRepository)) {
        fail('SUITE_UNKNOWN_TRACK', entry.id, `the nested-next runner has a suite for ${entry.id}, which the map does not hold as a ${suiteRepository} track`);
        continue;
      }
      let wanted;
      try {
        wanted = suiteScopes(entry);
      } catch (e) {
        fail('INVALID_SCOPE', `suite ${entry.id}`, e.message);
        continue;
      }
      const have = scopesOfTrack.get(entry.id) ?? [];
      for (const w of wanted) {
        const wp = parseScope(w).path;
        const covered = have.some((s) => {
          const p = parseScope(s);
          return p.dir && (wp === p.path || wp.startsWith(`${p.path}/`));
        });
        if (!covered) fail('SUITE_SCOPE_MISSING', entry.id, `${w} is not inside any scope of ${entry.id}`);
      }
    }
  }

  return sortErrors(errors);
}

export function classifyPath(map, repository, raw, options) {
  const p = normalizePath(raw, options);
  const hot = map.reserved_hot_paths.filter((h) => h.repository === repository && !scopeProblem(h.path) && scopeCoversPath(h.path, p));
  if (hot.length) return { path: p, status: 'hot', hot: hot.map((h) => h.path) };
  const owners = (fold) => [...new Set(map.tracks.filter((t) => t.repository === repository && ownedScopes(t).some((s) => scopeCoversPath(s, p, { fold }))).map((t) => t.track))].sort();
  const exact = owners(false);
  if (exact.length) return { path: p, status: 'track', tracks: exact };
  const folded = owners(true);
  if (folded.length || map.reserved_hot_paths.some((h) => h.repository === repository && !scopeProblem(h.path) && scopeCoversPath(h.path, p, { fold: true }))) return { path: p, status: 'case', tracks: folded };
  return { path: p, status: 'unowned' };
}

// Every path must be owned by `track` alone: another track's file, a reserved hot path, a path that matches only when
// case is ignored and a path inside no scope all fail. Nothing unknown passes.
export function checkPaths(map, { repository, track, paths, backslash }) {
  const problems = shapeProblems(map);
  if (problems.length) return sortErrors(problems.map((detail) => ({ code: 'MAP_SCHEMA', subject: 'map', detail })));
  const errors = [];
  const fail = (code, subject, detail) => errors.push({ code, subject, detail });
  if (!map.tracks.some((t) => t.track === track && t.repository === repository)) {
    fail('UNKNOWN_TRACK', String(track), `the map has no track ${track} in ${repository}`);
    return errors;
  }
  for (const raw of paths) {
    let c;
    try {
      c = classifyPath(map, repository, raw, { backslash });
    } catch (e) {
      fail('INVALID_PATH', JSON.stringify(raw), e.message);
      continue;
    }
    if (c.status === 'hot') fail('PATH_RESERVED_HOT', c.path, `reserved for the coordinator: ${c.hot.join(', ')}`);
    else if (c.status === 'case') fail('PATH_CASE_MISMATCH', c.path, 'matches a scope only when case is ignored');
    else if (c.status === 'unowned') fail('PATH_UNOWNED', c.path, 'inside no track scope (stable surface)');
    else if (c.tracks.length !== 1 || c.tracks[0] !== track) fail('PATH_OWNED_BY_OTHER_TRACK', c.path, `owned by ${c.tracks.join(', ')}, not only by ${track}`);
  }
  return errors;
}
