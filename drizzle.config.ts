import { defineConfig } from 'drizzle-kit';

/**
 * AR-22: migrations are SQL files, generated then reviewed and committed.
 * Never `drizzle-kit push` against a database with real data.
 * AR-23: forward-only — no down migrations.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  casing: 'snake_case',
  dbCredentials: {
    // DDL runs as the migrator role, which owns the tables. The runtime role
    // deliberately cannot do this.
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
