#!/usr/bin/env node
// D-cross-feature-fk-inference: the first automated, real-Postgres proof that the new
// `db_foreign_key` signal actually correlates a REAL live FK edge to the two features that declare
// each side's table. Same dedicated-job shape as scripts/db-introspect-smoke.mjs/
// scripts/ddl-apply-smoke.mjs -- a real, service-touching check kept out of the fast `test` job's
// default `npm test` path (see .github/workflows/ci.yml's cross-feature-fk job, own disposable
// `postgres:16` container/DB name/port, no collision with db-introspect/ddl-apply's own).
//
// Requires `BSKEL_TEST_DATABASE_URL` in the environment, pointing at a real (throwaway) Postgres
// this script is free to create/drop tables in -- never read from `.env`, matching this whole
// item's own `--database-url-env`-not-`.env` design (unchanged, reused from D-db-schema-plane).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { bskel, makeFail, establishThroughContract, REPO_ROOT } from './_smoke-lib.mjs';

const { Client } = pg;
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'java-compile');
const DB_URL_ENV_NAME = 'BSKEL_TEST_DATABASE_URL';
const fail = makeFail('cross-feature-fk-smoke');

function sh(cmd, args, cwd, opts = {}) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

async function rawQuery(connectionString, sql, params = []) {
	const client = new Client({ connectionString });
	await client.connect();
	try {
		return await client.query(sql, params);
	} finally {
		await client.end();
	}
}

const connectionString = process.env[DB_URL_ENV_NAME];
if (!connectionString) {
	fail(`${DB_URL_ENV_NAME} is not set -- point it at a real (throwaway) Postgres this script may create/drop tables in`);
}

console.log('cross-feature-fk-smoke: cleaning any leftover tables from a prior run...');
await rawQuery(connectionString, 'DROP TABLE IF EXISTS widgets, organizations');

console.log('cross-feature-fk-smoke: creating real widgets/organizations tables with a real FK constraint between them...');
await rawQuery(connectionString, 'CREATE TABLE organizations (id UUID PRIMARY KEY, name VARCHAR(255) NOT NULL)');
await rawQuery(connectionString, 'CREATE TABLE widgets (id UUID PRIMARY KEY, name VARCHAR(255) NOT NULL, organization_id UUID REFERENCES organizations (id))');

console.log('cross-feature-fk-smoke: copying the fixture to a scratch git repo, adding a SECOND module (organization)...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-cross-feature-fk-smoke-'));
fs.cpSync(FIXTURE, scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n.gradle/\nbuild/\ngradlew\ngradlew.bat\ngradle/wrapper/\n');

const orgDomainDir = path.join(scratch, 'src/main/java/com/example/demo/domain/organization/domain');
fs.mkdirSync(orgDomainDir, { recursive: true });
fs.writeFileSync(path.join(orgDomainDir, 'Organization.java'), `
package com.example.demo.domain.organization.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import jakarta.persistence.Id;

@Entity
@Table(name = "organizations")
public class Organization {
	@Id
	private String id;
}
`);

sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch, { quiet: true });
sh('git', ['config', 'user.email', 'test@example.com'], scratch, { quiet: true });
sh('git', ['config', 'user.name', 'Test'], scratch, { quiet: true });
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: cross-feature-fk-smoke fixture'], scratch, { quiet: true });
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-cross-feature-fk-smoke-origin-'));
sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin, { quiet: true });
sh('git', ['remote', 'add', 'origin', bareOrigin], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

console.log('cross-feature-fk-smoke: establishing both features (preflight -> init -> scan -> disposition -> contract -> cross-feature-check)...');
establishThroughContract(scratch, fail, {
	featureId: '001-widget-management', slug: 'widget-management', terms: 'widget', mode: 'reuse', note: 'x',
	contractStep: { kind: 'force', reason: 'no real OpenAPI oracle in this fixture' },
});
establishThroughContract(scratch, fail, {
	featureId: '002-organization-management', slug: 'organization-management', terms: 'organization', mode: 'reuse', note: 'x',
	contractStep: { kind: 'force', reason: 'no real OpenAPI oracle in this fixture' },
});

console.log('cross-feature-fk-smoke: re-running cross-feature-check with a REAL live DB connection...');
// bskel() (scripts/_smoke-lib.mjs) spawns via execFileSync with no explicit `env` override, so the
// child inherits this script's own process.env -- BSKEL_TEST_DATABASE_URL (already set, checked
// above) is visible to the CLI's own `process.env[flags['database-url-env']]` read with zero extra
// plumbing, exactly like every other smoke script in this project.
const r = bskel(['scan', 'cross-feature-check', '--feature', '001-widget-management', '--db', '--database-url-env', DB_URL_ENV_NAME, '--json'], scratch);
if (![0, 3].includes(r.code)) fail(`cross-feature-check --db: ${r.stderr || r.stdout}`);
let report;
try {
	report = JSON.parse(r.stdout).report;
} catch {
	fail(`cross-feature-check --db --json produced no parseable JSON: ${r.stdout}`);
}

if (report.fk_check.mode !== 'live') fail(`expected fk_check.mode === 'live', got: ${JSON.stringify(report.fk_check)}`);

const fkFinding = report.findings.find((f) => f.signal === 'db_foreign_key');
if (!fkFinding) fail(`expected a real db_foreign_key finding, got findings: ${JSON.stringify(report.findings)}`);
if (fkFinding.other_feature !== '002-organization-management') fail(`expected the FK finding to attribute 002-organization-management, got: ${JSON.stringify(fkFinding)}`);
if (fkFinding.direction !== 'references') fail(`expected direction 'references' (widgets has the FK column), got: ${fkFinding.direction}`);
if (fkFinding.confidence !== 'high') fail(`expected 'high' confidence (both @Table annotations are explicit), got: ${fkFinding.confidence}`);

console.log('cross-feature-fk-smoke: independently re-verifying the real FK constraint via a raw pg.Client query (not trusting the tool\'s own report)...');
const rawFk = await rawQuery(connectionString, `
	SELECT kcu.column_name, ccu.table_name AS references_table, ccu.column_name AS references_column
	FROM information_schema.table_constraints tc
	JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
	JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
	WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'widgets'`);
if (rawFk.rows.length !== 1) fail(`expected exactly 1 real FK constraint on widgets, got: ${JSON.stringify(rawFk.rows)}`);
const expectedIdentifier = `widgets.${rawFk.rows[0].column_name} -> ${rawFk.rows[0].references_table}.${rawFk.rows[0].references_column}`;
if (fkFinding.identifier !== expectedIdentifier) fail(`tool-reported identifier "${fkFinding.identifier}" does not match the raw, independently-queried FK constraint "${expectedIdentifier}"`);

console.log('cross-feature-fk-smoke: PASS -- a real live FK edge was correctly correlated to the two features that own each side, independently re-verified.');

console.log('cross-feature-fk-smoke: cleaning up...');
await rawQuery(connectionString, 'DROP TABLE IF EXISTS widgets, organizations');
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
