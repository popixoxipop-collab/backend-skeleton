// Offline Sequelize oracle: defines the fixture models on a postgres-dialect instance, stubs query
// execution (no server, no network) and prints the model metadata plus the CREATE TABLE statements
// that QueryInterface.createTable would send. Indexes added by sync() are not captured.
//   node oracle/introspect.mjs <fixture models.mjs>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DataTypes, Sequelize } from 'sequelize';

const fixture = path.resolve(process.argv[2]);
const sequelize = new Sequelize('postgres://oracle:oracle@127.0.0.1:1/oracle', { dialect: 'postgres', logging: false });
const captured = [];
sequelize.query = async (sql) => {
	captured.push(typeof sql === 'string' ? sql : sql.query);
	return [[], 0];
};

const { default: define } = await import(pathToFileURL(fixture).href);
define(sequelize, DataTypes);

const qi = sequelize.getQueryInterface();
const models = Object.values(sequelize.models);
const out = { models: [], sql: [] };
for (const model of models) {
	const table = model.getTableName();
	out.models.push({
		name: model.name,
		table: typeof table === 'string' ? table : { tableName: table.tableName, schema: table.schema },
		primaryKeyAttributes: model.primaryKeyAttributes,
		columns: Object.entries(model.tableAttributes).map(([attr, def]) => ({
			attr,
			field: def.field,
			primaryKey: Boolean(def.primaryKey),
			allowNull: def.allowNull !== false,
		})),
	});
}
for (const model of models) {
	await qi.createTable(model.getTableName(), model.tableAttributes, {}, model);
}
out.sql = captured;
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
