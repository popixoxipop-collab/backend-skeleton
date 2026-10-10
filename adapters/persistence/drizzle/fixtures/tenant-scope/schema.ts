// fixture-pin: drizzle-orm@0.45.4 drizzle-kit@0.31.11 case: tenant-scope
import { sql } from 'drizzle-orm';
import { pgPolicy, pgTable, text } from 'drizzle-orm/pg-core';

export const documents = pgTable('documents', {
	id: text('id').primaryKey(),
	tenantId: text('tenant_id').notNull(),
}, (t) => [
	pgPolicy('tenant_isolation', {
		as: 'permissive',
		for: 'all',
		using: sql`${t.tenantId} = current_setting('app.tenant_id')`,
	}),
]).enableRLS();
