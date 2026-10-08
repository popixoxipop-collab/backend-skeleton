// fixture-pin: drizzle-orm@0.45.4 drizzle-kit@0.31.11 case: unknown-table-creator
import { pgTableCreator, text } from 'drizzle-orm/pg-core';

const createTable = pgTableCreator((name) => `app_${name}`);

export const posts = createTable('posts', {
	id: text('id').primaryKey(),
});
