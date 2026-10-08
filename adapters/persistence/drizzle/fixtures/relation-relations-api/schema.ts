// fixture-pin: drizzle-orm@0.45.4 drizzle-kit@0.31.11 case: relation-relations-api
import { relations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';

export const authors = pgTable('authors', {
	id: text('id').primaryKey(),
});

export const books = pgTable('books', {
	id: text('id').primaryKey(),
	authorId: text('author_id').notNull(),
});

export const booksRelations = relations(books, ({ one }) => ({
	author: one(authors, { fields: [books.authorId], references: [authors.id] }),
}));
