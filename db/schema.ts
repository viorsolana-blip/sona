import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
export const records = sqliteTable('sona_records', {kind:text('kind').notNull(), id:text('id').notNull(), body:text('body').notNull()}, t=>[primaryKey({columns:[t.kind,t.id]})]);
export const revisions = sqliteTable('sona_revisions', {id:text('id').primaryKey().notNull(), revision:integer('revision').notNull()});
export const challenges = sqliteTable('sona_challenges', {id:text('id').primaryKey().notNull(),address:text('address').notNull(),message:text('message').notNull(),expires:integer('expires').notNull()},t=>[index('sona_challenges_expires').on(t.expires)]);
export const sessions = sqliteTable('sona_sessions', {hash:text('hash').primaryKey().notNull(),address:text('address').notNull(),expires:integer('expires').notNull()},t=>[index('sona_sessions_expires').on(t.expires)]);
export const limits = sqliteTable('sona_limits', {key:text('key').primaryKey().notNull(),window:integer('window').notNull(),count:integer('count').notNull()},t=>[index('sona_limits_window').on(t.window)]);
