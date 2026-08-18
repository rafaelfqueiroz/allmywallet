import { getTranslations } from 'next-intl/server';
import { groupNameKey, type GroupNames } from '@/core/reporting/grouping';
import { UNASSIGNED_GROUP_ID, type GroupKey } from '@/core/reporting/ports';

/**
 * SPEC-011 BR-011-06 / #63 — one group label, rendered the same way by every
 * report.
 *
 * **What it replaces.** `/reports/performance` printed `groupKey.id` verbatim:
 * a bare uuid when grouping by wallet, institution or asset, and the
 * untranslated enum `stock` / `fii` when grouping by asset class — an AR-44
 * violation on a user-facing table. `/reports` was worse in a quieter way: it
 * fell back to `group.holdings[0]?.assetCode`, so a wallet named "Aposentadoria"
 * rendered as whichever ticker sorted first inside it. A uuid is obviously
 * wrong; a real ticker in the wallet column is not, and a reader has no way to
 * tell that the label belongs to something else entirely.
 *
 * **Three sources, in one order, and the order is the point.** A synthetic
 * bucket is checked *before* the dimension, because `groupKeyResolver` derives
 * `synthetic` from the absence of the source value rather than by matching the
 * sentinel string — so a tenant who names a wallet `__unassigned__` still gets
 * their own name on their own group, and only the real residual bucket gets
 * the i18n label.
 */
export async function GroupLabel({
  groupKey,
  names,
}: {
  readonly groupKey: GroupKey;
  /** From `ReportQueryResult.groupNames`. */
  readonly names: GroupNames;
}) {
  const t = await getTranslations('reports');
  return <>{resolveGroupLabel(groupKey, names, t)}</>;
}

/**
 * The same three sources, as a **string**.
 *
 * SPEC-015 needs the label where JSX will not go: a chart wedge's name, a
 * legend entry, a cell serialised into a Client Component. Extracting it here
 * rather than re-deriving it there is the same argument `resolveGroupNames`
 * makes one layer down — a second copy of this ordering would eventually
 * disagree with the first, and the symptom would be one screen labelling a
 * group correctly while another labels it with a uuid.
 */
export function resolveGroupLabel(
  groupKey: GroupKey,
  names: GroupNames,
  t: (key: string) => string,
): string {
  if (groupKey.synthetic) {
    return groupKey.id === UNASSIGNED_GROUP_ID ? t('group.unassigned') : t('group.notClassified');
  }

  // Asset class is the one dimension whose ids are a closed enum rather than
  // tenant data, so its label lives in the message catalogue.
  if (groupKey.dimension === 'asset_class') return t(`assetClass.${groupKey.id}`);

  // The id is the last resort, not the first: reaching it means the name map
  // and the holding set disagree, which is a bug rather than a display case.
  // Rendering the id keeps the row readable and keeps the total honest.
  return names.get(groupNameKey(groupKey)) ?? groupKey.id;
}
