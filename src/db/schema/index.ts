/**
 * DV-13: a barrel is permitted here because this is a package-like boundary —
 * Drizzle needs one object holding every table to build the query builder's
 * relational types.
 *
 * Each spec adds its own file and re-exports it from here.
 */
export * from './users';
