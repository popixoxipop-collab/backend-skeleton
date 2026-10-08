// fixture-pin: drizzle-orm@0.45.4 drizzle-kit@0.31.11 case: normal
import { pgTable, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
	id: text('user_pk').primaryKey(),
	email: text('email').notNull(),
});
