// fixture-pin: sequelize@6.37.8 case: drift-v1
export default function define(sequelize, DataTypes) {
	const Account = sequelize.define('Account', {
		id: { type: DataTypes.INTEGER, primaryKey: true },
		fullName: { type: DataTypes.STRING, field: 'full_name', allowNull: false },
	}, { tableName: 'accounts', timestamps: false });
	return { Account };
}
