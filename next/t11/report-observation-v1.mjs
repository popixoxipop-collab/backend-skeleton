// T11-02 additive report-presence contract.
// The existing sbf.scan-report/2 and legacy bridge/parity stay byte-for-byte
// unchanged. This sidecar records whether a field was *reported*, explicitly
// null/undefined, observed empty, or held a value. It never invents endpoints,
// contracts, framework capabilities or independent execution evidence.
import crypto from 'node:crypto';

export const T11_REPORT_OBSERVATION_V1 = 'bskel.t11-report-observation/1';
const ARRAY_FIELDS = Object.freeze([
  'related_modules', 'path_prefix_signals', 'files_read',
]);
const SCALAR_FIELDS = Object.freeze([
  'adapter', 'verdict', 'confidence', 'api_surface_source',
]);
const MODULE_ARRAY_FIELDS = Object.freeze([
  'controllers', 'entities', 'enums', 'dtos',
]);
const MAX_MODULES = 2048;

function section(source, name, arrayType) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return Object.freeze({ state: 'invalid_container', itemCount: null });
  }
  const prop = Object.getOwnPropertyDescriptor(source, name);
  if (prop === undefined) {
    return Object.freeze({ state: 'not_reported', itemCount: null });
  }
  // A getter is not a reported data value. Never evaluate one, and never
  // silently flatten it to empty or claim it is present/valid.
  if (!Object.hasOwn(prop, 'value')) {
    return Object.freeze({ state: 'accessor_unsupported', itemCount: null });
  }
  const value = prop.value;
  if (value === undefined) {
    return Object.freeze({ state: 'explicit_undefined', itemCount: null });
  }
  if (value === null) {
    return Object.freeze({ state: 'explicit_null', itemCount: null });
  }
  if (arrayType) {
    if (!Array.isArray(value)) {
      return Object.freeze({ state: 'invalid_type', itemCount: null });
    }
    return Object.freeze({
      state: value.length === 0 ? 'reported_empty' : 'reported_value',
      itemCount: value.length,
    });
  }
  const scalar = typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
  if (!scalar) {
    return Object.freeze({ state: 'invalid_type', itemCount: null });
  }
  return Object.freeze({
    state: value === '' ? 'reported_empty' : 'reported_value',
    itemCount: null,
  });
}

export function observeLegacyScanReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      Object.getOwnPropertyDescriptor(report, 'schema')?.value !== 'sbf.scan-report/2') {
    throw new TypeError('expected an own sbf.scan-report/2 schema');
  }
  const fields = {};
  for (const name of ARRAY_FIELDS) fields[name] = section(report, name, true);
  for (const name of SCALAR_FIELDS) fields[name] = section(report, name, false);

  const related = Object.getOwnPropertyDescriptor(report, 'related_modules');
  const modules = related && Object.hasOwn(related, 'value') &&
    Array.isArray(related.value) ? related.value : [];

  if (modules.length > MAX_MODULES) {
    throw new RangeError('T11_OBSERVATION_MODULE_LIMIT');
  }
  const moduleSections = modules.map((value, index) => {
    const item = { index, fields: {} };
    item.fields.module = section(value, 'module', false);
    for (const name of MODULE_ARRAY_FIELDS) {
      item.fields[name] = section(value, name, true);
    }
    return Object.freeze({ index, fields: Object.freeze(item.fields) });
  });

  const noClaim = (value) => [
    'not_reported', 'explicit_null', 'explicit_undefined',
    'invalid_container', 'invalid_type', 'accessor_unsupported',
  ].includes(value.state);
  const incomplete = Object.values(fields).some(noClaim) ||
    moduleSections.some(item => Object.values(item.fields).some(noClaim));
  const evidence = {
    schema: T11_REPORT_OBSERVATION_V1,
    sourceReportSchema: 'sbf.scan-report/2',
    observationBasis: 'own_data_properties_only',
    claim: 'reported_field_presence_not_runtime_coverage',
    supportCertified: false,
    promotionAllowed: false,
    quality: incomplete ? 'incomplete_report_fields' : 'reported_fields_only',
    fields: Object.freeze(fields),
    modules: Object.freeze(moduleSections),
  };
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(evidence), 'utf8')
    .digest('hex');
  return Object.freeze({ ...evidence, observationSha256: digest });
}
