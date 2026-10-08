#!/usr/bin/env node
// Recomputes the machine-derived fields of adapters/persistence/<orm>/SCOPE.json (fixture hashes,
// expected oracle facts, provider output, agreement, migration-plane probe) from the committed files
// and this repository's own sources, then rewrites the record in canonical form.
//   node adapters/persistence/js-orm-scope-refresh.mjs <prisma|drizzle|typeorm|sequelize|all> [--check]
// Authored fields (constructs, case purposes, plans) are never touched. Requires ripgrep on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { ORMS, PERSISTENCE_DIR, ripgrepAvailable } from './lib/js-orm-scope-providers.mjs';
import { applyEvidence, computeEvidence, formatScope } from './lib/js-orm-scope-evidence.mjs';

const [target, flag] = process.argv.slice(2);
const targets = target === 'all' ? ORMS : [target];
if (!targets.every((orm) => ORMS.includes(orm)) || (flag && flag !== '--check')) {
	process.stderr.write('usage: js-orm-scope-refresh.mjs <prisma|drizzle|typeorm|sequelize|all> [--check]\n');
	process.exit(2);
}
if (!ripgrepAvailable()) {
	process.stderr.write('ripgrep (rg) is required: the TypeORM bridge and the migration scanner list files with it\n');
	process.exit(2);
}

let stale = false;
for (const orm of targets) {
	const file = path.join(PERSISTENCE_DIR, orm, 'SCOPE.json');
	const current = fs.readFileSync(file, 'utf8');
	const scope = JSON.parse(current);
	const next = formatScope(applyEvidence(scope, computeEvidence(orm, scope)));
	if (flag === '--check') {
		if (next !== current) {
			stale = true;
			process.stderr.write(`${orm}: SCOPE.json is stale\n`);
		}
	} else if (next !== current) {
		fs.writeFileSync(file, next);
		process.stderr.write(`${orm}: SCOPE.json rewritten\n`);
	} else {
		process.stderr.write(`${orm}: SCOPE.json unchanged\n`);
	}
}
process.exit(stale ? 1 : 0);
