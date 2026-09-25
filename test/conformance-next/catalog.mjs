const ID_RE = /^NEG-([A-Z]+)-(\\d{2})$/;
const REQUIRED_CATEGORIES = Object.freeze({ ID: 6, PROJ: 6, ROUTE: 8, SCHEMA: 8, AUTH: 6, DB: 6, CACHE: 6, RUN: 8, GAME: 7, TRUST: 8, GEN: 5, RELEASE: 5 });
const ALLOWED_STATUS = new Set(['specified-not-implemented', 'covered']);

export function validateNegativeCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return { ok: false, errors: ['(root): must be an object'] };
  if (catalog.contract !== 'sbf.negative-vectors/1') errors.push('contract: must equal sbf.negative-vectors/1');
  if (catalog.total !== 79) errors.push('total: must remain 79 for the T19 v1 baseline');
  if (!Array.isArray(catalog.vectors)) errors.push('vectors: must be an array');
  const counts = {};
  const ids = new Set();
  if (Array.isArray(catalog.vectors)) {
    for (const [i, v] of catalog.vectors.entries()) {
      const at = 'vectors[' + i + ']';
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(at + ': must be an object'); continue; }
      const m = ID_RE.exec(v.id ?? '');
      if (!m) errors.push(at + '.id: invalid negative-vector id');
      if (ids.has(v.id)) errors.push(at + '.id: duplicate ' + v.id);
      ids.add(v.id);
      if (m && m[1] !== v.category) errors.push(at + '.category: does not match id ' + v.id);
      if (!Object.hasOwn(REQUIRED_CATEGORIES, v.category)) errors.push(at + '.category: unknown category ' + v.category);
      counts[v.category] = (counts[v.category] ?? 0) + 1;
      if (typeof v.slug !== 'string' || !v.slug) errors.push(at + '.slug: required');
      if (typeof v.scenario !== 'string' || !v.scenario) errors.push(at + '.scenario: required');
      if (typeof v.expected_disposition !== 'string' || !v.expected_disposition) errors.push(at + '.expected_disposition: required');
      if (typeof v.critical !== 'boolean') errors.push(at + '.critical: must be boolean');
      if (!ALLOWED_STATUS.has(v.status)) errors.push(at + '.status: invalid status');
      if (!Array.isArray(v.implementation_refs)) errors.push(at + '.implementation_refs: must be an array');
      if (v.status === 'covered' && (!Array.isArray(v.implementation_refs) || v.implementation_refs.length === 0)) errors.push(at + ': covered vectors need at least one implementation ref');
    }
  }
  if (Array.isArray(catalog.vectors) && catalog.vectors.length !== 79) errors.push('vectors: expected 79, got ' + catalog.vectors.length);
  for (const [category, expected] of Object.entries(REQUIRED_CATEGORIES)) {
    if ((counts[category] ?? 0) !== expected) errors.push('category ' + category + ': expected ' + expected + ', got ' + (counts[category] ?? 0));
    if (catalog.category_counts?.[category] !== expected) errors.push('category_counts.' + category + ': expected ' + expected);
  }
  return { ok: errors.length === 0, errors, counts };
}

export function coverageSummary(catalog) {
  const verdict = validateNegativeCatalog(catalog);
  if (!verdict.ok) throw new Error('invalid negative-vector catalog:\n' + verdict.errors.join('\n'));
  const covered = catalog.vectors.filter((v) => v.status === 'covered');
  return {
    specified: catalog.vectors.length,
    covered: covered.length,
    uncovered: catalog.vectors.length - covered.length,
    critical_specified: catalog.vectors.filter((v) => v.critical).length,
    critical_covered: covered.filter((v) => v.critical).length,
    status: covered.length === catalog.vectors.length ? 'complete' : 'incomplete'
  };
}
