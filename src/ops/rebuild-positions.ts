import { asc, isNull } from 'drizzle-orm';
import { db, closePool, type Database } from '@/db/client';
import { users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { UserId, isUuid } from '@/core/shared/ids';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { DrizzlePositionRepository } from '@/adapters/db/position-repository';
import {
  rebuildPositions,
  verifyPositions,
  type PositionDrift,
  type RebuildDependencies,
} from '@/core/positions/rebuild';
import { hashUserId, logger } from '@/lib/logger';

/**
 * `pnpm positions:rebuild` — SPEC-007 BR-007-14 / DM-4's repair mechanism,
 * and the entry point it did not have.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * `rebuildPositions` was written, unit-tested, integration-tested against real
 * Postgres, and called by nothing — `tests/structural/use-cases-have-callers.
 * test.ts` recorded it against #10 for exactly that reason. DL-006-01's whole
 * bargain is that positions are derived and rebuildable, so "a calculation bug
 * is fixed by correcting the logic and replaying". That bargain is worthless
 * without something an operator can actually run, and there is no staging
 * environment to try it on first.
 *
 * A CLI rather than a queued job, deliberately. A rebuild is not scheduled —
 * nothing about it wants a cron — and it is not user-triggered. It is a human
 * responding to a suspicion, and that human needs to *see* what changed. A
 * queued job would put the answer in a log they have to go and find, which is
 * the wrong shape for a repair tool. If per-tenant async rebuilds are ever
 * needed, the queue can be added around the same use case without changing it.
 *
 * **It reports the drift whether or not it writes.** `--dry-run` is simply
 * "report and stop" — see `verifyPositions` for why the comparison is
 * separated from the write at all.
 * ---------------------------------------------------------------------------
 */

export interface RebuildOptions {
  /** Exactly one of these two is required — there is no implicit default. */
  readonly userId?: UserId | undefined;
  readonly all?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface TenantRebuildOutcome {
  readonly userId: UserId;
  readonly checked: number;
  readonly drift: readonly PositionDrift[];
  readonly written: boolean;
}

function buildDeps(tx: Parameters<Parameters<Database['transaction']>[0]>[0], userId: UserId) {
  return {
    transactions: new DrizzleTransactionRepository(tx, userId),
    positions: new DrizzlePositionRepository(tx, userId),
  } satisfies RebuildDependencies;
}

/**
 * One tenant, in one transaction (AR-11). The verify and the write share that
 * transaction on purpose: a rebuild that reported a drift computed from one
 * snapshot of the ledger and then wrote a different one would describe a
 * change that never happened.
 */
export async function rebuildForTenant(
  userId: UserId,
  options: { readonly dryRun: boolean },
  database: Database = db,
): Promise<TenantRebuildOutcome> {
  return withTenant(
    userId,
    async (tx) => {
      const deps = buildDeps(tx, userId);

      const verification = await verifyPositions(deps);
      if (!verification.ok) {
        // A ledger that cannot be replayed is not a cache problem, and
        // overwriting the cache with a partial replay would make it one.
        throw new Error(
          `positions:rebuild refused for one tenant: the ledger cannot be replayed ` +
            `(${verification.error.code}). Nothing was written.`,
        );
      }

      if (options.dryRun) {
        return {
          userId,
          checked: verification.value.checked,
          drift: verification.value.drift,
          written: false,
        };
      }

      const rebuilt = await rebuildPositions(deps);
      if (!rebuilt.ok) {
        throw new Error(`positions:rebuild failed: ${rebuilt.error.code}`);
      }

      return {
        userId,
        checked: verification.value.checked,
        drift: verification.value.drift,
        written: true,
      };
    },
    database,
  );
}

/**
 * AR-15: `users` carries no tenant column of its own and is read outside
 * `withTenant`. Soft-deleted accounts are skipped — SPEC-004's grace window
 * leaves the row in place, and rebuilding positions for an account on its way
 * out is work nobody asked for.
 */
async function listTenants(database: Database): Promise<readonly UserId[]> {
  const rows = await database
    .select({ id: users.id })
    .from(users)
    .where(isNull(users.deletedAt))
    .orderBy(asc(users.id));
  return rows.map((row) => UserId.of(row.id));
}

export async function rebuildAll(
  options: RebuildOptions,
  database: Database = db,
): Promise<readonly TenantRebuildOutcome[]> {
  const dryRun = options.dryRun === true;

  const tenants = options.userId !== undefined ? [options.userId] : await listTenants(database);

  const outcomes: TenantRebuildOutcome[] = [];
  for (const userId of tenants) {
    const outcome = await rebuildForTenant(userId, { dryRun }, database);
    outcomes.push(outcome);

    // AR-39/SPEC-003: the log names a hashed user id and structural counts —
    // never a figure, and never anything that identifies a person.
    logger.info(
      {
        userId: hashUserId(userId),
        checked: outcome.checked,
        drifted: outcome.drift.length,
        written: outcome.written,
      },
      outcome.drift.length === 0
        ? 'positions rebuild: cache already agreed with the ledger'
        : 'positions rebuild: cache disagreed with the ledger',
    );
  }

  return outcomes;
}

/**
 * Argument parsing, exported so it can be tested without running anything.
 * Returns a message instead of options when the invocation is not one this
 * command will act on — there is no implicit "all tenants", because the one
 * thing a repair tool must never do is more than it was asked to.
 */
export function parseArgs(argv: readonly string[]): RebuildOptions | { readonly usage: string } {
  const dryRun = argv.includes('--dry-run');
  const all = argv.includes('--all');
  const userFlag = argv.indexOf('--user');
  const rawUser = userFlag === -1 ? undefined : argv[userFlag + 1];

  const usage =
    'usage: pnpm positions:rebuild (--user <uuid> | --all) [--dry-run]\n' +
    '  --user <uuid>  rebuild one tenant\n' +
    '  --all          rebuild every active tenant\n' +
    '  --dry-run      report what would change, write nothing';

  if (all && rawUser !== undefined) return { usage };
  if (!all && rawUser === undefined) return { usage };

  if (rawUser !== undefined) {
    // Checked before `UserId.of`, which throws: a mistyped id on an operator
    // command should print usage, not a stack trace.
    if (!isUuid(rawUser)) return { usage };
    return { userId: UserId.of(rawUser), dryRun };
  }
  return { all: true, dryRun };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('usage' in parsed) {
    console.error(parsed.usage);
    process.exitCode = 1;
    return;
  }

  const outcomes = await rebuildAll(parsed);
  const drifted = outcomes.filter((outcome) => outcome.drift.length > 0);

  console.info(
    `${parsed.dryRun === true ? 'Checked' : 'Rebuilt'} ${outcomes.length} tenant(s); ` +
      `${drifted.length} had positions that disagreed with the ledger.`,
  );

  for (const outcome of drifted) {
    for (const drift of outcome.drift) {
      // The asset id, not a name: this output can end up pasted into an issue
      // (AR-39). What an operator needs is which position moved and by how
      // much, which the figures give without naming anything.
      console.info(
        `  ${drift.kind}  asset=${drift.key.assetId} institution=${drift.key.institutionId ?? '—'}\n` +
          `      cached : ${drift.cached === null ? '(none)' : JSON.stringify(drift.cached)}\n` +
          `      ledger : ${drift.rebuilt === null ? '(none)' : JSON.stringify(drift.rebuilt)}`,
      );
    }
  }

  // A dry run that found drift is a *finding*, and an operator scripting this
  // needs it to be distinguishable from a clean one without parsing prose.
  if (parsed.dryRun === true && drifted.length > 0) process.exitCode = 2;
}

if (process.argv[1]?.includes('rebuild-positions')) {
  main()
    .then(async () => {
      await closePool();
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'positions rebuild failed');
      process.exit(1);
    });
}
