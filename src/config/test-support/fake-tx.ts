import type { Tx } from '@/config/tx';

/**
 * A minimal stand-in for the slice of Drizzle's chainable query-builder
 * surface `src/config/*.ts` actually calls (`select().from().where()`,
 * optionally `.limit()`; `insert().values().onConflictDoUpdate()`;
 * `delete().where()`), so branches that don't depend on real SQL semantics —
 * row found vs. not found, insert-vs-update path taken, cache invalidated on
 * write — are unit-testable without Postgres (fast, no Testcontainers).
 *
 * `Tx` is not a port in the AR-02/AR-03 sense (it is not declared in
 * `core/`), so TS-02's "fakes implement the real port interface, no mocking
 * libraries" is about ports specifically — hand-faking Drizzle's own API
 * here is a pragmatic escape hatch for this framework-adjacent module, not a
 * substitute for the real thing. The DB-backed behaviour these fakes stand
 * in for is still exercised for real in tests/integration/ and
 * tests/isolation/ — that is what actually proves the SQL is correct.
 */
export function fakeTx(
  options: {
    readonly selectRows?: readonly unknown[];
    readonly onInsertValues?: (values: unknown) => void;
    readonly onDelete?: () => void;
  } = {},
): Tx {
  const rows = options.selectRows ?? [];

  function selectChain(): unknown {
    const chain = Promise.resolve(rows) as Promise<unknown> & Record<string, unknown>;
    chain['from'] = () => chain;
    chain['where'] = () => chain;
    chain['orderBy'] = () => chain;
    chain['limit'] = () => Promise.resolve(rows);
    return chain;
  }

  function mutationChain(onValues?: (values: unknown) => void): unknown {
    const chain = Promise.resolve(undefined) as Promise<unknown> & Record<string, unknown>;
    chain['values'] = (values: unknown) => {
      onValues?.(values);
      return chain;
    };
    chain['onConflictDoUpdate'] = () => chain;
    chain['where'] = () => chain;
    return chain;
  }

  return {
    select: () => selectChain(),
    insert: () => mutationChain(options.onInsertValues),
    update: () => mutationChain(),
    delete: () => {
      options.onDelete?.();
      return mutationChain();
    },
    execute: () => Promise.resolve({ rows: [] }),
  } as unknown as Tx;
}

/** A `Tx` that throws if any method is invoked — proves a code path never reaches the database. */
export function poisonTx(): Tx {
  const explode = (): never => {
    throw new Error(
      'poisonTx: unexpected database call — this code path must not reach the database',
    );
  };
  return {
    select: explode,
    insert: explode,
    update: explode,
    delete: explode,
    execute: explode,
  } as unknown as Tx;
}
