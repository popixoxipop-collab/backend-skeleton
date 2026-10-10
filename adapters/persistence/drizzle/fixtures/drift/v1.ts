// fixture-pin: drizzle-orm@0.45.4 drizzle-kit@0.31.11 case: drift-v1
import { pgTable, text } from 'drizzle-orm/pg-core';

export const profiles = pgTable('profiles', {
	id: text('id').primaryKey(),
	fullName: text('full_name').notNull(),
});
