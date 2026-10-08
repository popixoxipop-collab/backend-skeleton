// fixture-pin: sequelize@6.37.8 case: composite-key
export default function define(sequelize, DataTypes) {
	const Tenant = sequelize.define('Tenant', {
		id: { type: DataTypes.STRING, primaryKey: true, field: 'tenant_pk' },
	}, { tableName: 'tenants', timestamps: false });

	const User = sequelize.define('User', {
		id: { type: DataTypes.STRING, primaryKey: true, field: 'user_pk' },
	}, { tableName: 'users', timestamps: false });

	const TenantUser = sequelize.define('TenantUser', {
		userId: { type: DataTypes.STRING, primaryKey: true, field: 'user_id', references: { model: 'users', key: 'user_pk' } },
		tenantId: { type: DataTypes.STRING, primaryKey: true, field: 'tenant_id', references: { model: 'tenants', key: 'tenant_pk' } },
	}, { tableName: 'tenant_users', timestamps: false });

	return { Tenant, User, TenantUser };
}
