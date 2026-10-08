// Offline TypeORM oracle: transpiles decorator fixtures, builds an in-memory sql.js DataSource
// (no server, no network) and prints entity metadata plus the schema-builder DDL as JSON.
//   node oracle/introspect.mjs <fixtureDir>
//   node oracle/introspect.mjs --drift <fromFixtureDir> <toFixtureDir>
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { DataSource, getMetadataArgsStorage } from 'typeorm';

const NAMING_FILE = 'naming-strategy.ts';
const buildRoot = fs.mkdtempSync(path.join(process.cwd(), '.build-'));
let buildCount = 0;

async function loadModule(file) {
	const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
		loader: 'ts',
		format: 'esm',
		target: 'es2022',
		tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
	});
	const out = path.join(buildRoot, `m${buildCount++}.mjs`);
	fs.writeFileSync(out, code);
	return import(pathToFileURL(out).href);
}

async function loadFixture(dir) {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== NAMING_FILE).sort();
	const tables = getMetadataArgsStorage().tables;
	const entities = [];
	for (const name of files) {
		const mod = await loadModule(path.join(dir, name));
		for (const value of Object.values(mod)) {
			if (typeof value === 'function' && tables.some((t) => t.target === value)) entities.push(value);
		}
	}
	let namingStrategy;
	if (fs.existsSync(path.join(dir, NAMING_FILE))) {
		const Strategy = (await loadModule(path.join(dir, NAMING_FILE))).default;
		namingStrategy = new Strategy();
	}
	return { entities, namingStrategy };
}

function typeName(type) {
	return typeof type === 'function' ? type.name : String(type);
}

function describe(ds) {
	return ds.entityMetadatas.map((m) => ({
		name: m.name,
		tableName: m.tableName,
		primary: m.primaryColumns.map((c) => c.databaseName),
		columns: m.columns.map((c) => ({ prop: c.propertyName, db: c.databaseName, type: typeName(c.type), primary: c.isPrimary, nullable: c.isNullable })),
		foreignKeys: m.foreignKeys.map((fk) => ({ columns: fk.columnNames, refTable: fk.referencedTablePath, refColumns: fk.referencedColumnNames })),
	}));
}

const args = process.argv.slice(2);
let result;
if (args[0] === '--drift') {
	const from = await loadFixture(path.resolve(args[1]));
	const to = await loadFixture(path.resolve(args[2]));
	const dsFrom = new DataSource({ type: 'sqljs', entities: from.entities, namingStrategy: from.namingStrategy, synchronize: true });
	await dsFrom.initialize();
	const snapshot = dsFrom.sqljsManager.exportDatabase();
	const dsTo = new DataSource({ type: 'sqljs', database: snapshot, entities: to.entities, namingStrategy: to.namingStrategy, synchronize: false });
	await dsTo.initialize();
	const log = await dsTo.driver.createSchemaBuilder().log();
	result = { from: describe(dsFrom), to: describe(dsTo), upgrade: log.upQueries.map((q) => q.query) };
	await dsFrom.destroy();
	await dsTo.destroy();
} else {
	const fixture = await loadFixture(path.resolve(args[0]));
	const ds = new DataSource({ type: 'sqljs', entities: fixture.entities, namingStrategy: fixture.namingStrategy, synchronize: false });
	await ds.initialize();
	const log = await ds.driver.createSchemaBuilder().log();
	result = { entities: describe(ds), ddl: log.upQueries.map((q) => q.query) };
	await ds.destroy();
}
fs.rmSync(buildRoot, { recursive: true, force: true });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
