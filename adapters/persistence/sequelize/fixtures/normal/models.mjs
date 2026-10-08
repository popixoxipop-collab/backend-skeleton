// fixture-pin: sequelize@6.37.8 case: normal
export default function define(sequelize, DataTypes) {
	const User = sequelize.define('User', {
		id: { type: DataTypes.STRING, primaryKey: true, field: 'user_pk' },
		email: { type: DataTypes.STRING, allowNull: false },
	}, { tableName: 'users', timestamps: false });
	return { User };
}
