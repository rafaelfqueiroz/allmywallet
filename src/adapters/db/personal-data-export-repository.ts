import { eq } from 'drizzle-orm';
import { assets, institutions } from '@/db/schema/assets';
import { transactions } from '@/db/schema/transactions';
import { fixedIncomeContracts } from '@/db/schema/import-rows';
import { wallets, walletAllocations } from '@/db/schema/wallets';
import { walletGoals } from '@/db/schema/goals';
import { configOverrides } from '@/db/schema/config';
import { users } from '@/db/schema/users';
import type { Tx } from '@/db/tenant';
import { AssetId, type UserId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import type {
  ExportedAllocation,
  ExportedWalletGoal,
  ExportedFixedIncomeContract,
  ExportedPreference,
  ExportedProfile,
  ExportedTransaction,
  ExportedWallet,
  PersonalDataExportPort,
} from '@/core/privacy/ports';

/**
 * SPEC-004 BR-004-11. Reads every tenant-scoped table directly rather than
 * composing SPEC-006/SPEC-010/SPEC-009's own repositories: the seam this port
 * exists for is "read everything for a user, shaped for an export", which is
 * a different query per table than any single existing repository's own read
 * model. Must be constructed with a `withTenant` transaction — every table
 * below except `users` is `FORCE`-RLS'd.
 */
export class DrizzlePersonalDataExportRepository implements PersonalDataExportPort {
  constructor(private readonly tx: Tx) {}

  async loadProfile(userId: UserId): Promise<ExportedProfile | null> {
    const [row] = await this.tx
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) return null;
    return { id: userId, email: row.email, name: row.name, createdAt: row.createdAt };
  }

  async loadTransactions(userId: UserId): Promise<readonly ExportedTransaction[]> {
    const rows = await this.tx
      .select({
        id: transactions.id,
        tradeDate: transactions.tradeDate,
        assetCode: assets.code,
        assetName: assets.name,
        institutionName: institutions.name,
        type: transactions.type,
        status: transactions.status,
        quantity: transactions.quantity,
        unitPrice: transactions.unitPrice,
        fees: transactions.fees,
        totalValue: transactions.totalValue,
        isManual: transactions.isManual,
      })
      .from(transactions)
      .innerJoin(assets, eq(transactions.assetId, assets.id))
      .leftJoin(institutions, eq(transactions.institutionId, institutions.id))
      .where(eq(transactions.userId, userId));

    return rows.map((row) => ({
      id: row.id,
      tradeDate: BusinessDate.of(row.tradeDate),
      assetCode: row.assetCode,
      assetName: row.assetName,
      institutionName: row.institutionName,
      type: row.type,
      status: row.status,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      fees: row.fees,
      totalValue: row.totalValue,
      isManual: row.isManual,
    }));
  }

  async loadWallets(userId: UserId): Promise<readonly ExportedWallet[]> {
    const rows = await this.tx
      .select({
        id: wallets.id,
        name: wallets.name,
        description: wallets.description,
        goal: wallets.goal,
      })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    return rows;
  }

  /**
   * SPEC-019's `wallet_goals` — BR-004-05's export covers every tenant-scoped
   * entity, and a goal is one: the name is the user's own words, the amount is
   * a target for their money.
   */
  async loadWalletGoals(userId: UserId): Promise<readonly ExportedWalletGoal[]> {
    const rows = await this.tx
      .select({
        walletId: walletGoals.walletId,
        name: walletGoals.name,
        kind: walletGoals.kind,
        amount: walletGoals.amount,
        basis: walletGoals.basis,
        period: walletGoals.period,
        achievedOn: walletGoals.achievedOn,
      })
      .from(walletGoals)
      .where(eq(walletGoals.userId, userId));
    return rows.map((row) => ({
      ...row,
      achievedOn: (row.achievedOn as BusinessDate | null) ?? null,
    }));
  }

  async loadAllocations(userId: UserId): Promise<readonly ExportedAllocation[]> {
    const rows = await this.tx
      .select({
        walletId: walletAllocations.walletId,
        assetId: walletAllocations.assetId,
        assetCode: assets.code,
        quantity: walletAllocations.quantity,
        costBasisAtAllocation: walletAllocations.costBasisAtAllocation,
      })
      .from(walletAllocations)
      .innerJoin(assets, eq(walletAllocations.assetId, assets.id))
      .where(eq(walletAllocations.userId, userId));

    return rows.map((row) => ({
      walletId: row.walletId,
      assetId: AssetId.of(row.assetId),
      assetCode: row.assetCode,
      quantity: row.quantity,
      costBasisAtAllocation: row.costBasisAtAllocation,
    }));
  }

  async loadFixedIncomeContracts(userId: UserId): Promise<readonly ExportedFixedIncomeContract[]> {
    const rows = await this.tx
      .select({
        assetId: fixedIncomeContracts.assetId,
        assetCode: assets.code,
        indexer: fixedIncomeContracts.indexer,
        rate: fixedIncomeContracts.rate,
        issueDate: fixedIncomeContracts.issueDate,
        maturityDate: fixedIncomeContracts.maturityDate,
        principal: fixedIncomeContracts.principal,
      })
      .from(fixedIncomeContracts)
      .innerJoin(assets, eq(fixedIncomeContracts.assetId, assets.id))
      .where(eq(fixedIncomeContracts.userId, userId));

    return rows.map((row) => ({
      assetId: AssetId.of(row.assetId),
      assetCode: row.assetCode,
      indexer: row.indexer,
      ratePercent: row.rate,
      issueDate: BusinessDate.of(row.issueDate),
      maturityDate: row.maturityDate === null ? null : BusinessDate.of(row.maturityDate),
      principal: row.principal,
    }));
  }

  /** BR-004-11's "preferences" — this user's own `config_overrides` rows (SPEC-002 BR-002-10: tenant/user-level rows are tenant data). `userId IS NOT NULL` already excludes every deployment-level (global) row, since those carry `NULL` (the CHECK constraint in `0002_config_layer.sql`). */
  async loadPreferences(userId: UserId): Promise<readonly ExportedPreference[]> {
    return this.tx
      .select({ key: configOverrides.key, value: configOverrides.value })
      .from(configOverrides)
      .where(eq(configOverrides.userId, userId));
  }
}
