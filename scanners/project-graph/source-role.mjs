// T02 canonical source-role vocabulary, reconciled from legacy Track A PR #63.
// This module classifies repository-relative paths only. It does not parse source code, decide
// language/framework semantics, or imply that a file belongs in a runtime contract.

const REFERENCE_SEGMENTS = new Set([
  'reference', 'references', 'example', 'examples', 'sample', 'samples', 'upstream',
  'fixtures-reference', 'fixture', 'fixtures', 'test', 'tests', '__tests__',
]);
const GENERATED_SEGMENTS = new Set(['dist', 'build', 'generated', 'out', '.svelte-kit', '.next']);
const VENDOR_SEGMENTS = new Set(['vendor', 'vendors', 'third_party', 'third-party']);
const TEMPLATE_SEGMENTS = new Set(['template', 'templates', 'scaffold', 'scaffolds']);

export const PROJECT_SOURCE_ROLES = Object.freeze([
  'active',
  'reference',
  'generated',
  'vendor',
  'template',
]);

export function classifyProjectSourceRole(repoRelativePath) {
  if (typeof repoRelativePath !== 'string' || repoRelativePath.length === 0) {
    throw new TypeError('repoRelativePath must be a non-empty string');
  }
  const normalized = repoRelativePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const segments = normalized.toLowerCase().split('/').filter(Boolean);
  const base = segments.at(-1) ?? '';

  // Deliberate precedence matches the legacy Track A behavior: vendored code remains vendor even
  // when nested under an examples/tests path; reference beats generated; generated beats template.
  if (segments.some((segment) => VENDOR_SEGMENTS.has(segment))) return 'vendor';
  if (segments.some((segment) => REFERENCE_SEGMENTS.has(segment))) return 'reference';
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) return 'generated';
  if (
    segments.some((segment) => TEMPLATE_SEGMENTS.has(segment)) ||
    /\.(?:tmpl|template|mustache|hbs)$/i.test(base)
  ) {
    return 'template';
  }
  return 'active';
}

export function groupProjectSourcesByRole(paths) {
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array');
  const grouped = Object.fromEntries(PROJECT_SOURCE_ROLES.map((role) => [role, []]));
  for (const file of [...paths].sort()) {
    const role = classifyProjectSourceRole(file);
    grouped[role].push(file);
  }
  return grouped;
}
