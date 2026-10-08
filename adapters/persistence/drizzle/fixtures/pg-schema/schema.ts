// fixture-pin: drizzle-orm@0.45.4 drizzle-kit@0.31.11 case: pg-schema
import { pgSchema, text } from 'drizzle-orm/pg-core';

export const auth = pgSchema('auth');

export const accounts = auth.table('accounts', {
	id: text('id').primaryKey(),
});
