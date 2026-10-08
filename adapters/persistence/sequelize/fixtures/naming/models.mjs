// fixture-pin: sequelize@6.37.8 case: naming
export default function define(sequelize, DataTypes) {
	const UserAccount = sequelize.define('UserAccount', {
		displayName: { type: DataTypes.STRING },
	});
	const SnakeCaseModel = sequelize.define('SnakeCaseModel', {
		displayName: { type: DataTypes.STRING },
	}, { underscored: true });
	SnakeCaseModel.belongsTo(UserAccount);
	return { UserAccount, SnakeCaseModel };
}
