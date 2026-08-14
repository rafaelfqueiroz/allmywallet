import { toCsv } from '@/lib/csv';
import type { UserId } from '@/core/shared/ids';
import type { Money } from '@/core/shared/money';
import type { PrivacyDependencies } from '@/core/privacy/dependencies';
import type { ExportedConsent, ExportedProfile, PersonalDataExport } from '@/core/privacy/ports';

/**
 * SPEC-004 BR-004-11 — self-service, machine-readable export of every
 * tenant-scoped entity: profile, transactions, wallets, allocations,
 * fixed-income contracts, consents and preferences.
 *
 * Deviation from the issue's implementation plan, recorded here and in the
 * #7 report: the plan calls for generation "in the worker... delivered as a
 * signed, expiring download." No object-storage adapter exists in this
 * codebase yet (Cloudflare R2 is BL-001, explicitly deferred until the first
 * real user account), so there is nowhere to put a signed URL that points at
 * anything. This use case instead returns the export synchronously — a route
 * handler (`src/app/api/privacy/export/`) calls it directly and streams the
 * result, the same AR-33 allowance SPEC-006's CSV export already uses. At
 * this stage's data volumes (one ledger, not millions of rows) synchronous
 * generation inside a request is not a real cost; swapping in a queued,
 * signed-URL version later is a change to the route handler and the
 * `PersonalDataExportPort` adapter, not to this use case.
 */
export async function exportUserData(
  deps: PrivacyDependencies,
  userId: UserId,
): Promise<PersonalDataExport | null> {
  const profile = await deps.exportData.loadProfile(userId);
  if (profile === null) return null;

  const [transactions, wallets, allocations, fixedIncomeContracts, preferences, consentRecords] =
    await Promise.all([
      deps.exportData.loadTransactions(userId),
      deps.exportData.loadWallets(userId),
      deps.exportData.loadAllocations(userId),
      deps.exportData.loadFixedIncomeContracts(userId),
      deps.exportData.loadPreferences(userId),
      deps.consents.listForUser(userId),
    ]);

  const consents: readonly ExportedConsent[] = consentRecords.map((record) => ({
    purpose: record.purpose,
    grantedAt: record.grantedAt,
    revokedAt: record.revokedAt,
    policyVersion: record.policyVersion,
  }));

  // Traceability, not BR-004-17 (that rule is about an *operator* reading
  // someone else's data — this is the user reading their own, self-service,
  // which needs no such record to be lawful). Logged anyway because "who
  // generated an export of this account, and when" is cheap to have and
  // exactly the kind of fact an access trail exists for.
  await deps.auditLog.record({
    actor: userId,
    userId,
    action: 'privacy.export.generated',
    entityType: 'user',
    entityKey: userId,
  });

  return { profile, transactions, wallets, allocations, fixedIncomeContracts, consents, preferences };
}

/**
 * AR-10: every `Money`/`Quantity` field's `.toJSON()` is already a plain
 * decimal string (`core/shared/money.ts`), so `JSON.stringify` never touches
 * a `Decimal` directly — this function relies on that rather than
 * re-implementing serialisation.
 */
export function exportUserDataAsJson(data: PersonalDataExport): string {
  return JSON.stringify(data, null, 2);
}

function moneyOrEmpty(value: Money | null): string {
  return value === null ? '' : value.toString();
}

function isoOrEmpty(value: Date | null): string {
  return value === null ? '' : value.toISOString();
}

/**
 * BR-004-11's CSV half. One `toCsv` table per entity type, concatenated with
 * a `# name` marker row ahead of each — there is no zip/archive dependency in
 * this codebase (DEVELOPMENT.md §1's canonical list has none), and every
 * entity here is small enough at this stage's volumes that a single
 * multi-section file is a reasonable trade against introducing one. The
 * profile — one row, not a table — is included as a two-row section for
 * consistency with the rest rather than left out of the CSV half of the AC.
 */
export function exportUserDataAsCsv(data: PersonalDataExport): string {
  const sections: (readonly string[])[] = [];

  sections.push(...section('profile', ['id', 'email', 'name', 'created_at'], [profileRow(data.profile)]));

  sections.push(
    ...section(
      'transactions',
      [
        'id',
        'trade_date',
        'asset_code',
        'asset_name',
        'institution',
        'type',
        'status',
        'quantity',
        'unit_price',
        'fees',
        'total_value',
        'is_manual',
      ],
      data.transactions.map((t) => [
        t.id,
        t.tradeDate,
        t.assetCode,
        t.assetName,
        t.institutionName ?? '',
        t.type,
        t.status,
        t.quantity.toString(),
        t.unitPrice.toString(),
        t.fees.toString(),
        t.totalValue.toString(),
        t.isManual ? 'true' : 'false',
      ]),
    ),
  );

  sections.push(
    ...section(
      'wallets',
      ['id', 'name', 'description', 'goal'],
      data.wallets.map((w) => [w.id, w.name, w.description ?? '', w.goal ?? '']),
    ),
  );

  sections.push(
    ...section(
      'wallet_allocations',
      ['wallet_id', 'asset_id', 'asset_code', 'quantity', 'cost_basis_at_allocation'],
      data.allocations.map((a) => [
        a.walletId,
        a.assetId,
        a.assetCode,
        a.quantity.toString(),
        moneyOrEmpty(a.costBasisAtAllocation),
      ]),
    ),
  );

  sections.push(
    ...section(
      'fixed_income_contracts',
      ['asset_id', 'asset_code', 'indexer', 'rate_percent', 'issue_date', 'maturity_date', 'principal'],
      data.fixedIncomeContracts.map((c) => [
        c.assetId,
        c.assetCode,
        c.indexer ?? '',
        c.ratePercent?.toString() ?? '',
        c.issueDate,
        c.maturityDate ?? '',
        moneyOrEmpty(c.principal),
      ]),
    ),
  );

  sections.push(
    ...section(
      'consents',
      ['purpose', 'granted_at', 'revoked_at', 'policy_version'],
      data.consents.map((c) => [c.purpose, isoOrEmpty(c.grantedAt), isoOrEmpty(c.revokedAt), c.policyVersion]),
    ),
  );

  sections.push(
    ...section(
      'preferences',
      ['key', 'value'],
      data.preferences.map((p) => [p.key, JSON.stringify(p.value)]),
    ),
  );

  return toCsv(sections);
}

function profileRow(profile: ExportedProfile): readonly string[] {
  return [profile.id, profile.email, profile.name ?? '', profile.createdAt.toISOString()];
}

function section(
  name: string,
  header: readonly string[],
  rows: readonly (readonly string[])[],
): (readonly string[])[] {
  return [[`# ${name}`], header, ...rows, []];
}
