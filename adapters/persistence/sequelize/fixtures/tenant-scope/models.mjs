// fixture-pin: sequelize@6.37.8 case: tenant-scope
export default function define(sequelize, DataTypes) {
	const Document = sequelize.define('Document', {
		id: { type: DataTypes.INTEGER, primaryKey: true },
		tenantId: { type: DataTypes.STRING, field: 'tenant_id', allowNull: false },
	}, {
		tableName: 'documents',
		timestamps: false,
		defaultScope: { where: { tenantId: 'tenant-a' } },
		scopes: { other: { where: { tenantId: 'tenant-b' } } },
	});
	return { Document };
}
