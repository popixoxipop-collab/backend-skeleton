import {
  compilePermissionPolicy,
  validatePermissionManifest,
} from './permission-manifest.mjs';
import {
  validateArtifactTrustPolicy,
} from './artifact-trust.mjs';
import { buildTrustRequirements } from './trust-requirements.mjs';

export const SERVICE_ACCESS_REQUIREMENTS_CONTRACT = 'bskel.service-access-requirements/1';

const CLASSES = new Set(['database-read', 'database-write', 'local-server']);
const SECRET_REF = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

function fail(code, message, details = null) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== null) error.details = details;
  throw error;
}

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactEndpoint(value, field) {
  if (!plain(value) || typeof value.host !== 'string' ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    fail('SERVICE_ENDPOINT_INVALID', `${field} must contain host:string and port:1..65535`);
  }
  return { host: value.host, port: value.port };
}

function validateTrustPolicy(policy) {
  const validation = validateArtifactTrustPolicy(policy);
  if (!validation.ok) fail('SERVICE_TRUST_POLICY_INVALID', 'artifact trust policy is invalid', validation.errors);
  return validation.value;
}

function buildPermission(candidate, code) {
  const validation = validatePermissionManifest(candidate);
  if (!validation.ok) fail(code, 'T20 rejected service access permissions', validation.errors);
  return compilePermissionPolicy(validation.value).manifest;
}

function trustBundle(permissionManifest, artifactTrustPolicy) {
  return buildTrustRequirements({ permissionManifest, artifactTrustPolicy });
}

export function buildDatabaseAccessRequirements({
  mode,
  endpoint,
  secretRef,
  artifactTrustPolicy,
  limits = {},
}) {
  const serviceClass = mode === 'read' ? 'database-read' : mode === 'write' ? 'database-write' : null;
  if (!serviceClass) fail('DATABASE_ACCESS_MODE_INVALID', 'mode must be read or write');
  const db = exactEndpoint(endpoint, 'endpoint');
  if (typeof secretRef !== 'string' || !SECRET_REF.test(secretRef)) {
    fail('DATABASE_SECRET_REF_INVALID', 'secretRef must be an opaque T20 secret reference identifier');
  }
  const trustPolicy = validateTrustPolicy(artifactTrustPolicy);
  const permission = buildPermission({
    schema: 'bskel.trust-permissions/1',
    read_roots: [],
    write_roots: [],
    network: { mode: 'allowlist', allow: [{ host: db.host, ports: [db.port] }] },
    listen: { mode: 'deny', allow: [] },
    process: { mode: 'deny', executables: [], max_children: 0 },
    environment: { allow: [] },
    secret_refs: [secretRef],
    devices: { mode: 'deny', allow: [] },
    limits: { ...limits },
  }, 'DATABASE_ACCESS_PERMISSION_REJECTED');

  return Object.freeze({
    contract: SERVICE_ACCESS_REQUIREMENTS_CONTRACT,
    service_class: serviceClass,
    endpoint: Object.freeze(db),
    secret_ref: secretRef,
    permission_manifest: permission,
    trust_requirements: trustBundle(permission, trustPolicy),
    read_only_required: mode === 'read',
    mutation_approval_required: mode === 'write',
    destructive_ddl_allowed: false,
    production_target_allowed_by_default: false,
    executable_now: false,
    runtime_binding_required: true,
    evidence_required: true,
    note: mode === 'read'
      ? 'Runtime must independently prove the admitted DB path is read-only; network+credential possession alone is not read-only evidence.'
      : 'Write intent requires a separate mutation approval and runtime evidence; this trust request never authorizes destructive DDL.',
  });
}

export function buildLocalServerRequirements({
  bind,
  connectAllow = [],
  secretRefs = [],
  artifactTrustPolicy,
  limits = {},
}) {
  const listener = exactEndpoint(bind, 'bind');
  if (!Array.isArray(connectAllow) || connectAllow.length > 64) fail('LOCAL_SERVER_CONNECT_INVALID', 'connectAllow must contain at most 64 endpoints');
  const outbound = connectAllow.map((x, i) => exactEndpoint(x, `connectAllow[${i}]`));
  if (!Array.isArray(secretRefs) || secretRefs.length > 64 ||
      secretRefs.some((x) => typeof x !== 'string' || !SECRET_REF.test(x))) {
    fail('LOCAL_SERVER_SECRET_REFS_INVALID', 'secretRefs must be at most 64 opaque T20 secret identifiers');
  }
  const trustPolicy = validateTrustPolicy(artifactTrustPolicy);
  const permission = buildPermission({
    schema: 'bskel.trust-permissions/1',
    read_roots: [],
    write_roots: [],
    network: outbound.length === 0
      ? { mode: 'deny', allow: [] }
      : { mode: 'allowlist', allow: outbound.map((x) => ({ host: x.host, ports: [x.port] })) },
    listen: { mode: 'allowlist', allow: [{ host: listener.host, ports: [listener.port] }] },
    process: { mode: 'deny', executables: [], max_children: 0 },
    environment: { allow: [] },
    secret_refs: [...secretRefs],
    devices: { mode: 'deny', allow: [] },
    limits: { ...limits },
  }, 'LOCAL_SERVER_PERMISSION_REJECTED');

  return Object.freeze({
    contract: SERVICE_ACCESS_REQUIREMENTS_CONTRACT,
    service_class: 'local-server',
    bind: Object.freeze(listener),
    outbound: Object.freeze(outbound.map(Object.freeze)),
    permission_manifest: permission,
    trust_requirements: trustBundle(permission, trustPolicy),
    public_bind_allowed: false,
    executable_now: false,
    runtime_binding_required: true,
    cleanup_proof_required: true,
    evidence_required: true,
    note: 'This trust revision permits loopback listeners only. External/public bind requires a distinct future review rather than reusing local-server approval.',
  });
}
