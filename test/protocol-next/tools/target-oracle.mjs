#!/usr/bin/env node
// Static oracle runner for the T18 protocol targets. It compares the REAL protocol importers with an independent
// reference implementation and writes test/protocol-next/fixtures/targets/<family>.oracle.json.
//
//   node test/protocol-next/tools/target-oracle.mjs --family graphql|asyncapi --oracle-dir <abs dir outside the repo> [--install]
//
// With --install the tool runs `npm install --ignore-scripts` for the pinned reference packages inside the oracle
// directory; third-party packages are never installed inside the repository. The committed evidence is only read by the
// tests; nothing here runs during `npm test` and nothing here is runtime evidence.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT,
  canonicalSha256,
  comparableGraphqlView,
  divergentCategories,
  lfSha256,
  multisetDiff,
  readJson,
  readText,
  repoPath,
  runCase,
  targetFiles,
} from '../_target-helpers.mjs';

export const EVIDENCE_SCHEMA = 'sbf.protocol-target-oracle-evidence/1';
export const TOOL_PATH = 'test/protocol-next/tools/target-oracle.mjs';
export const HELPERS_PATH = 'test/protocol-next/_target-helpers.mjs';
export const LOCK_DIR = 'test/protocol-next/fixtures/targets/oracle-locks';

export const ORACLE_PINS = Object.freeze({
  graphql: Object.freeze([
    Object.freeze({ dir: 'gql16', packages: Object.freeze([Object.freeze({ name: 'graphql', version: '16.14.2' })]) }),
    Object.freeze({ dir: 'gql17', packages: Object.freeze([Object.freeze({ name: 'graphql', version: '17.0.2' })]) }),
  ]),
  asyncapi: Object.freeze([
    Object.freeze({
      dir: 'aapi',
      packages: Object.freeze([
        Object.freeze({ name: '@asyncapi/parser', version: '3.6.3' }),
        Object.freeze({ name: '@asyncapi/specs', version: '6.11.1' }),
      ]),
    }),
  ]),
});

export const GRAPHQL_NORMALIZATION = Object.freeze([
  'introspection kinds object and input_object are mapped to type and input',
  'whitespace inside type references is removed',
  'built-in scalars (Boolean, Float, ID, Int, String) and double-underscore meta types are excluded on both sides',
  'argument default values are excluded (graphql-js 16 exposes defaultValue, graphql-js 17 deprecates it in favour of default.literal)',
  'schemas holds a root list only when the document has an explicit schema definition or is an introspection result',
]);

const sortStrings = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const firstLine = (message) => String(message).split('\n')[0].slice(0, 300);

function parseArgs(argv) {
  const args = { install: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install') args.install = true;
    else if (arg === '--family') args.family = argv[(i += 1)];
    else if (arg === '--oracle-dir') args.oracleDir = argv[(i += 1)];
    else throw new Error('unknown argument ' + arg);
  }
  if (!ORACLE_PINS[args.family]) throw new Error('--family must be one of ' + Object.keys(ORACLE_PINS).join(', '));
  if (!args.oracleDir || !path.isAbsolute(args.oracleDir)) throw new Error('--oracle-dir must be an absolute path');
  if (isInsideRepository(args.oracleDir)) {
    throw new Error('--oracle-dir must be outside the repository: third-party packages are installed in scratch space only');
  }
  return args;
}

function physicalPath(target) {
  let existing = path.resolve(target);
  const missing = [];
  while (!fs.lstatSync(existing, { throwIfNoEntry: false })) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

export function isInsideRepository(candidate) {
  const relative = path.relative(fs.realpathSync(REPO_ROOT), physicalPath(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { command: [command, ...args].join(' '), exit_code: result.status, stderr_tail: String(result.stderr ?? '').trim().split('\n').slice(-3).join('\n') };
}

function prepareGroup(group, oracleDir, install) {
  const groupDir = path.join(oracleDir, group.dir);
  let installRecord = { performed_by_tool: false };
  if (install) {
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'package.json'), JSON.stringify({ name: 'protocol-oracle-' + group.dir, version: '0.0.0', private: true }, null, 2) + '\n');
    const specs = group.packages.map((pkg) => pkg.name + '@' + pkg.version);
    const result = run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...specs], groupDir);
    installRecord = { performed_by_tool: true, command: result.command, exit_code: result.exit_code };
    if (result.exit_code !== 0) throw new Error('npm install failed in ' + groupDir + ': ' + result.stderr_tail);
  }
  const lockPath = path.join(groupDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) throw new Error('missing package-lock.json in ' + groupDir + ' (run with --install)');
  const lockText = fs.readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(lockText);
  const vendoredLock = LOCK_DIR + '/' + group.dir + '.lock.json';
  fs.mkdirSync(path.dirname(repoPath(vendoredLock)), { recursive: true });
  fs.writeFileSync(repoPath(vendoredLock), lockText.replace(/\r\n/g, '\n'));
  const packages = group.packages.map((pkg) => {
    const installed = JSON.parse(fs.readFileSync(path.join(groupDir, 'node_modules', ...pkg.name.split('/'), 'package.json'), 'utf8'));
    if (installed.version !== pkg.version) throw new Error(pkg.name + ' resolved to ' + installed.version + ', expected the pin ' + pkg.version);
    const locked = lock.packages?.['node_modules/' + pkg.name] ?? {};
    return { name: pkg.name, version: installed.version, integrity: locked.integrity ?? null };
  });
  return {
    groupDir,
    record: {
      group: group.dir,
      install: installRecord,
      lockfile: { path: vendoredLock, lf_sha256: lfSha256(lockText) },
      packages,
    },
  };
}

function graphqlInputKind(caseDef) {
  return caseDef.oracle?.input_kind === 'introspection' ? 'introspection' : 'sdl';
}

function describeGraphqlType(graphql, type) {
  if (graphql.isObjectType(type)) return 'type';
  if (graphql.isInterfaceType(type)) return 'interface';
  if (graphql.isInputObjectType(type)) return 'input';
  if (graphql.isEnumType(type)) return 'enum';
  if (graphql.isUnionType(type)) return 'union';
  return 'scalar';
}

// What the reference implementation sees and the importer has no record for.
function graphqlUnrepresented(graphql, schema) {
  const implementsList = [];
  const unionMembers = [];
  const enumValues = [];
  const usages = [];
  const usage = (nodes, where) => {
    for (const node of nodes ?? []) usages.push('@' + node.name.value + ' on ' + where);
  };
  usage(schema.astNode?.directives, 'schema');
  for (const extension of schema.extensionASTNodes ?? []) usage(extension.directives, 'schema');
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__') || graphql.isSpecifiedScalarType(type)) continue;
    usage(type.astNode?.directives, type.name);
    for (const extension of type.extensionASTNodes ?? []) usage(extension.directives, type.name);
    if (graphql.isObjectType(type) || graphql.isInterfaceType(type)) {
      for (const iface of type.getInterfaces()) implementsList.push(type.name + ' implements ' + iface.name);
    }
    if (graphql.isObjectType(type) || graphql.isInterfaceType(type) || graphql.isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) usage(field.astNode?.directives, type.name + '.' + field.name);
    }
    if (graphql.isUnionType(type)) unionMembers.push(type.name + ' = ' + type.getTypes().map((member) => member.name).sort().join(' | '));
    if (graphql.isEnumType(type)) enumValues.push(type.name + ': ' + type.getValues().map((value) => value.name).sort().join(','));
  }
  return {
    directive_definitions: sortStrings(schema.getDirectives().filter((directive) => !graphql.isSpecifiedDirective(directive)).map((directive) => '@' + directive.name)),
    directive_usages: sortStrings(usages),
    enum_values: sortStrings(enumValues),
    implements: sortStrings(implementsList),
    union_members: sortStrings(unionMembers),
  };
}

function graphqlStructure(graphql, schema, inputKind) {
  const argText = (args) => (args.length ? '(' + args.map((arg) => arg.name + ': ' + String(arg.type)).join(', ') + ')' : '');
  const types = [];
  const fields = [];
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__') || graphql.isSpecifiedScalarType(type)) continue;
    types.push(describeGraphqlType(graphql, type) + ' ' + type.name);
    if (graphql.isObjectType(type) || graphql.isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) fields.push(type.name + '.' + field.name + argText(field.args) + ': ' + String(field.type));
    } else if (graphql.isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) fields.push(type.name + '.' + field.name + ': ' + String(field.type));
    }
  }
  const roots = [['query', schema.getQueryType()], ['mutation', schema.getMutationType()], ['subscription', schema.getSubscriptionType()]].filter(([, type]) => type);
  const operations = roots.flatMap(([kind, type]) => Object.values(type.getFields()).map((field) => kind + ' ' + type.name + '.' + field.name + argText(field.args) + ': ' + String(field.type)));
  const explicitSchema = inputKind === 'introspection' || schema.astNode != null;
  return {
    schemas: explicitSchema ? [roots.map(([kind, type]) => kind + '=' + type.name).join(' ')] : [],
    types: sortStrings(types),
    fields: sortStrings(fields),
    operations: sortStrings(operations),
    unrepresented: graphqlUnrepresented(graphql, schema),
  };
}

function graphqlOracleRun(graphql, inputKind, text) {
  let schema;
  try {
    if (inputKind === 'sdl') {
      schema = graphql.buildSchema(text);
    } else {
      const parsed = JSON.parse(text);
      schema = graphql.buildClientSchema(parsed?.data?.__schema ? parsed.data : parsed);
    }
  } catch (error) {
    return { build: 'error', error: firstLine(error.message), validation_errors: [], valid: false, structure: null };
  }
  const validationErrors = graphql.validateSchema(schema).map((error) => firstLine(error.message));
  const valid = validationErrors.length === 0;
  return { build: 'ok', error: null, validation_errors: validationErrors, valid, structure: valid ? graphqlStructure(graphql, schema, inputKind) : null };
}

function runGraphqlOracle(cases, groups) {
  const loaded = groups.map((group, index) => {
    const graphql = createRequire(path.join(group.groupDir, 'index.cjs'))('graphql');
    return { version: group.record.packages[0].version, graphql, newest: index === groups.length - 1 };
  });
  const results = {};
  for (const caseDef of cases) {
    const inputKind = graphqlInputKind(caseDef);
    const versions = {};
    for (const entry of loaded) {
      const { structure, ...rest } = graphqlOracleRun(entry.graphql, inputKind, caseDef.input.text);
      versions[entry.version] = { ...rest, structure };
    }
    const entries = Object.values(versions);
    const verdict = entries.every((entry) => entry.valid) ? 'valid' : entries.every((entry) => !entry.valid) ? 'invalid' : 'split';
    const structures = entries.map((entry) => entry.structure).filter(Boolean);
    const versionsAgree = verdict !== 'split' && new Set(structures.map((structure) => JSON.stringify(structure))).size <= 1;
    results[caseDef.id] = {
      input_kind: inputKind,
      verdict,
      versions_agree: versionsAgree,
      versions: Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, {
        build: entry.build,
        error: entry.error,
        validation_errors: entry.validation_errors,
        valid: entry.valid,
      }])),
      structure: structures.length ? structures[structures.length - 1] : null,
    };
  }
  return results;
}

function compareGraphql(caseDef, oracleResult) {
  const outcome = runCase('graphql', caseDef);
  if (!outcome.ok) return { adapter_verdict: 'error', agrees_on_acceptance: oracleResult.verdict === 'invalid', divergent_categories: [], diff: {} };
  const adapterVerdict = outcome.scan.completeness.status === 'blocked' ? 'blocked' : 'accepted';
  const agreesOnAcceptance = (adapterVerdict === 'accepted') === (oracleResult.verdict === 'valid');
  if (adapterVerdict !== 'accepted' || !oracleResult.structure) return { adapter_verdict: adapterVerdict, agrees_on_acceptance: agreesOnAcceptance, divergent_categories: [], diff: {} };
  const adapterView = comparableGraphqlView(outcome.scan);
  const categories = ['schemas', 'types', 'fields', 'operations'];
  const diverging = divergentCategories(adapterView, oracleResult.structure, categories);
  return {
    adapter_verdict: adapterVerdict,
    agrees_on_acceptance: agreesOnAcceptance,
    divergent_categories: diverging,
    diff: Object.fromEntries(diverging.map((category) => [category, multisetDiff(adapterView[category], oracleResult.structure[category])])),
  };
}

async function runAsyncapiOracle(cases, groups) {
  const group = groups[0];
  const { Parser } = createRequire(path.join(group.groupDir, 'index.cjs'))('@asyncapi/parser');
  const parser = new Parser();
  const results = {};
  for (const caseDef of cases) {
    const parsed = await parser.parse(caseDef.input.text);
    const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 0);
    const document = parsed.document;
    const valid = Boolean(document) && errors.length === 0;
    results[caseDef.id] = {
      verdict: valid ? 'valid' : 'invalid',
      parsed_version: document ? String(document.version()) : null,
      error_codes: sortStrings(new Set(errors.map((error) => error.code))),
      first_error: errors.length ? firstLine(errors[0].message) : null,
      counts: valid ? {
        channels: document.channels().length,
        operations: document.operations().length,
        components_messages: document.components().messages().length,
        all_messages: document.allMessages().length,
      } : null,
    };
  }
  return results;
}

function compareAsyncapi(caseDef, oracleResult) {
  const outcome = runCase('asyncapi', caseDef);
  if (!outcome.ok) return { adapter_verdict: 'error', agrees_on_acceptance: oracleResult.verdict === 'invalid', divergent_categories: [], adapter_counts: null };
  const adapterVerdict = outcome.scan.completeness.status === 'blocked' ? 'blocked' : 'accepted';
  const agreesOnAcceptance = (adapterVerdict === 'accepted') === (oracleResult.verdict === 'valid');
  const adapterCounts = {
    channels: outcome.scan.asyncapi.channels.length,
    operations: outcome.scan.asyncapi.operations.length,
    messages: outcome.scan.asyncapi.messages.length,
  };
  if (adapterVerdict !== 'accepted' || !oracleResult.counts) return { adapter_verdict: adapterVerdict, agrees_on_acceptance: agreesOnAcceptance, divergent_categories: [], adapter_counts: adapterCounts };
  const oracle = oracleResult.counts;
  const divergent = [];
  if (adapterCounts.channels !== oracle.channels) divergent.push('channels');
  if (adapterCounts.operations !== oracle.operations) divergent.push('operations');
  if (adapterCounts.messages !== oracle.components_messages) divergent.push('messages');
  if (adapterCounts.messages !== oracle.all_messages) divergent.push('all_messages');
  return { adapter_verdict: adapterVerdict, agrees_on_acceptance: agreesOnAcceptance, divergent_categories: divergent, adapter_counts: adapterCounts };
}

export function comparedCases(fixtures) {
  return fixtures.cases.filter((caseDef) => caseDef.oracle?.compare === true);
}

export function comparedInputsSha256(cases) {
  return canonicalSha256(cases.map((caseDef) => ({ id: caseDef.id, input: caseDef.input })).sort((a, b) => (a.id < b.id ? -1 : 1)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = targetFiles(args.family);
  const fixtures = readJson(files.fixtures);
  const cases = comparedCases(fixtures);
  const groups = ORACLE_PINS[args.family].map((group) => prepareGroup(group, args.oracleDir, args.install));

  const oracleResults = args.family === 'graphql' ? runGraphqlOracle(cases, groups) : await runAsyncapiOracle(cases, groups);
  const results = {};
  for (const caseDef of cases) {
    const oracleResult = oracleResults[caseDef.id];
    const comparison = args.family === 'graphql' ? compareGraphql(caseDef, oracleResult) : compareAsyncapi(caseDef, oracleResult);
    results[caseDef.id] = { oracle: oracleResult, comparison };
  }

  const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  const ids = Object.keys(results);
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    family: args.family,
    generated_on: new Date().toISOString().slice(0, 10),
    claim: 'Static comparison of the real protocol importer with an independent reference implementation. This is not runtime evidence and not certification.',
    runtime_tested: false,
    environment: { node: process.version, npm: npmVersion.status === 0 ? String(npmVersion.stdout).trim() : null, platform: process.platform + '-' + process.arch },
    tool: { path: TOOL_PATH, lf_sha256: lfSha256(readText(TOOL_PATH)) },
    helpers: { path: HELPERS_PATH, lf_sha256: lfSha256(readText(HELPERS_PATH)) },
    fixtures: { path: files.fixtures, compared_case_ids: ids.slice().sort(), compared_inputs_sha256: comparedInputsSha256(cases) },
    oracle_packages: groups.map((group) => group.record),
    ...(args.family === 'graphql' ? { normalization: GRAPHQL_NORMALIZATION } : {}),
    results,
    summary: {
      compared: ids.length,
      agree_on_acceptance: ids.filter((id) => results[id].comparison.agrees_on_acceptance).length,
      adapter_accepts_oracle_rejects: ids.filter((id) => results[id].comparison.adapter_verdict === 'accepted' && results[id].oracle.verdict === 'invalid').sort(),
      with_divergent_categories: ids.filter((id) => results[id].comparison.divergent_categories.length > 0).sort(),
    },
  };
  fs.writeFileSync(repoPath(files.oracle), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ wrote: files.oracle, ...evidence.summary }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
