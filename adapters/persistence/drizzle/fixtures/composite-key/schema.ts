// fixture-pin: drizzle-orm@0.45.4 drizzle-kit@0.31.11 case: composite-key
import { pgTable, text, primaryKey } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
	id: text('tenant_pk').primaryKey(),
});

export const users = pgTable('users', {
	id: text('user_pk').primaryKey(),
});

export const tenantUsers = pgTable('tenant_users', {
	userId: text('user_id').notNull().references(() => users.id),
	tenantId: text('tenant_id').notNull().references(() => tenants.id),
}, (t) => [primaryKey({ columns: [t.userId, t.tenantId] })]);
