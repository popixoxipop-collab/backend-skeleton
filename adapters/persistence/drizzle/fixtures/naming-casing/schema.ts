// fixture-pin: drizzle-orm@0.45.4 drizzle-kit@0.31.11 case: naming-casing
import { pgTable, text } from 'drizzle-orm/pg-core';

export const userAccounts = pgTable('user_accounts', {
	userId: text().primaryKey(),
	displayName: text().notNull(),
});
