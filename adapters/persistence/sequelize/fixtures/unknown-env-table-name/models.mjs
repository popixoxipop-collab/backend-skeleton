// fixture-pin: sequelize@6.37.8 case: unknown-env-table-name
export default function define(sequelize, DataTypes) {
	const prefix = process.env.TABLE_PREFIX ?? '';
	const Event = sequelize.define('Event', {
		id: { type: DataTypes.INTEGER, primaryKey: true },
	}, { tableName: prefix + 'events', timestamps: false });
	return { Event };
}
