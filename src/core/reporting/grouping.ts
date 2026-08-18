import {
  GROUPINGS,
  NOT_CLASSIFIED_GROUP_ID,
  UNASSIGNED_GROUP_ID,
  type GroupKey,
  type Grouping,
  type ReportHolding,
  type ReportInstitution,
  type ReportWallet,
  type Scope,
} from '@/core/reporting/ports';

/**
 * SPEC-011 BR-011-03/06/09/10 — the grouping dimension, resolved.
 *
 * **This file contains exactly one decision, made exactly once.**
 * `groupKeyResolver` is the only place in the codebase that decides which
 * group a holding belongs to, and all four reports (SPEC-012..015) call it.
 * That is BR-011-06 ("grouping behaves identically across all four reports")
 * expressed as code rather than as a convention: four private copies would
 * drift, and the first symptom would not look like a bug — it would look like
 * two screens that disagree about the same portfolio, with nothing on either
 * one to say which is wrong (DL-011-02).
 */

/**
 * BR-011-03 — the resolver. One function, returning `(holding) => GroupKey`,
 * so every report partitions the same holding set identically.
 *
 * The two synthetic buckets are produced here and nowhere else:
 *
 *  - **BR-011-09, Unassigned.** A holding no wallet has claimed
 *    (`walletId === null`) groups under `UNASSIGNED_GROUP_ID` rather than
 *    being skipped. This is what makes "the wallet groups plus Unassigned sum
 *    to the portfolio" true by construction — SPEC-010 DL-010-07 forbids
 *    hiding it, because hidden it would make the wallet view quietly fail to
 *    add up.
 *
 *  - **BR-011-10, "Not classified".** Sector is undefined for fixed income,
 *    and fixed income is a large share of a typical Brazilian portfolio; an
 *    institution is likewise not always recorded. Those holdings group under
 *    `NOT_CLASSIFIED_GROUP_ID`. **It is a group, never a filter** (DL-011-04):
 *    dropping them would make the sector view disagree with every other view
 *    of the same scope, and the user could not see why.
 *
 * `synthetic` is derived from the *absence of the source value*, not by
 * comparing the resulting id against a sentinel. That ordering matters: it
 * means a real sector or wallet name can never be mistaken for a synthetic
 * bucket, however the sentinel strings are chosen.
 */
export function groupKeyResolver(grouping: Grouping): (holding: ReportHolding) => GroupKey {
  switch (grouping) {
    case 'asset_class':
      // Always present — every asset in the catalog carries a class (the
      // `assets_class_check` constraint guarantees one of eight). There is no
      // "Not classified" branch here because there is no way to reach one.
      return (holding) => key('asset_class', holding.assetClass, false);

    case 'wallet':
      return (holding) =>
        holding.walletId === null
          ? key('wallet', UNASSIGNED_GROUP_ID, true)
          : key('wallet', holding.walletId, false);

    case 'asset':
      // Also always present: a holding exists because a position does, and a
      // position has an asset (a foreign key makes it so).
      return (holding) => key('asset', holding.assetId, false);

    case 'sector':
      return (holding) =>
        holding.sector === null
          ? key('sector', NOT_CLASSIFIED_GROUP_ID, true)
          : key('sector', holding.sector, false);

    case 'institution':
      return (holding) =>
        holding.institutionId === null
          ? key('institution', NOT_CLASSIFIED_GROUP_ID, true)
          : key('institution', holding.institutionId, false);
  }
}

function key(dimension: Grouping, id: string, synthetic: boolean): GroupKey {
  return { dimension, id, synthetic };
}

/**
 * BR-011-04 — asset class is the default at portfolio scope; individual asset
 * is the default within a single wallet.
 *
 * The reason the two differ is worth stating, because it looks arbitrary. At
 * portfolio scope the useful first question is "what am I exposed to", which
 * is a class-level question. Inside one wallet the user has already answered
 * it — they chose the wallet — so the useful first question becomes "what is
 * actually in here", which is asset-level. Grouping a four-asset wallet by
 * asset class mostly produces four groups of one.
 *
 * Both are user-configurable (SPEC-002): `configured` is the resolved value of
 * `reports.default_grouping` / `reports.default_grouping_wallet_scope`, and
 * `undefined` falls back to the spec's default. AR-40 has already validated
 * the value against the registry's enum by the time it arrives here.
 */
export function defaultGroupingFor(scope: Scope, configured?: Grouping | undefined): Grouping {
  if (configured !== undefined) return configured;
  return scope.kind === 'wallet' ? 'asset' : 'asset_class';
}

const GROUPING_SET: ReadonlySet<string> = new Set<Grouping>(GROUPINGS);

export function isGrouping(value: string): value is Grouping {
  return GROUPING_SET.has(value);
}

/**
 * Deterministic group ordering.
 *
 * Two properties, both deliberate:
 *
 *  1. **Synthetic buckets sort last.** "Unassigned" and "Not classified" are
 *     residuals — a reader scanning a report wants the classified groups
 *     first, and the leftover at the bottom where leftovers belong. It also
 *     keeps the bucket in a stable place as real groups come and go.
 *  2. **Everything else sorts by id**, which is stable across runs and across
 *     processes. Reports that want a value-ordered view (Composition wants
 *     largest-first) re-sort for display; the framework's job is to be
 *     *reproducible*, so that two runs of the same report — and two runs of
 *     the CSV export — are byte-identical.
 *
 * Sorting by display name is deliberately not done here: names are tenant data
 * resolved in the UI (AR-44), and locale-aware collation in `core/` would make
 * the domain's output depend on the reader's locale.
 */
export function compareGroupKeys(a: GroupKey, b: GroupKey): number {
  if (a.synthetic !== b.synthetic) return a.synthetic ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * BR-011-06 / #63 — the tenant-data name behind each group key.
 *
 * **Why this exists at all.** `GroupKey.id` is an *identity*, not a label: a
 * wallet uuid, an institution uuid, an asset uuid, a sector string, an asset
 * class enum. Every report page rendered that id directly, so grouping by
 * wallet produced a table of bare uuids on `/reports/performance`, and on
 * `/reports` a fallback to `holdings[0].assetCode` labelled a *wallet* with
 * whichever asset happened to sort first inside it — a real name, attached to
 * the wrong thing, which is worse than a uuid because it looks right.
 *
 * **The names still resolve in the UI** (AR-44, and `compareGroupKeys` above
 * says so explicitly). This function does not render anything: it hands the UI
 * the lookup it was missing, built once from the same holding set the groups
 * came from, so all four reports label a group identically for the same reason
 * they partition it identically.
 *
 * `asset_class` and the two synthetic buckets are deliberately absent — those
 * labels are i18n keys, not tenant data, and belong in the message catalogue.
 * A caller that finds no entry renders the i18n label or falls back to the id.
 */
export type GroupNames = ReadonlyMap<string, string>;

/** The lookup key: a dimension's ids are only unique within that dimension. */
export function groupNameKey(key: GroupKey): string {
  return `${key.dimension}:${key.id}`;
}

export interface GroupNameSources {
  readonly holdings: readonly ReportHolding[];
  readonly wallets: readonly ReportWallet[];
  readonly institutions: readonly ReportInstitution[];
}

export function resolveGroupNames(grouping: Grouping, sources: GroupNameSources): GroupNames {
  const names = new Map<string, string>();

  switch (grouping) {
    case 'wallet':
      for (const wallet of sources.wallets) {
        names.set(`wallet:${wallet.walletId}`, wallet.name);
      }
      return names;

    case 'institution':
      for (const institution of sources.institutions) {
        names.set(`institution:${institution.institutionId}`, institution.name);
      }
      return names;

    case 'asset':
      // The ticker, not the long name: it is what the user typed, what the
      // broker prints, and what every other table on the site shows.
      for (const holding of sources.holdings) {
        names.set(`asset:${holding.assetId}`, holding.assetCode);
      }
      return names;

    case 'sector':
      // The id *is* the sector name (`groupKeyResolver` above keys on
      // `holding.sector`), so the map is an identity — built anyway so the
      // caller has one uniform path rather than a special case per dimension.
      for (const holding of sources.holdings) {
        if (holding.sector !== null) names.set(`sector:${holding.sector}`, holding.sector);
      }
      return names;

    case 'asset_class':
      // An i18n key (`reports.assetClass.*`), never tenant data.
      return names;
  }
}
