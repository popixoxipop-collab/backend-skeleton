// fixture-pin: sequelize@6.37.8 case: drift-v2
export default function define(sequelize, DataTypes) {
	const Account = sequelize.define('Account', {
		id: { type: DataTypes.INTEGER, primaryKey: true },
		displayName: { type: DataTypes.STRING, field: 'display_name', allowNull: false },
	}, { tableName: 'accounts', timestamps: false });
	return { Account };
}
