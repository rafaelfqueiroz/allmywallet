import { createTranslator } from 'next-intl';
import messages from '@/i18n/messages/pt-BR.json';
import { DEFAULT_LOCALE } from '@/i18n/request';
import { formatCurrency, formatDateTime } from '@/i18n/format';
import type { OpportunityAlert } from '@/core/opportunity/ports';

/**
 * SPEC-018 BR-018-28/AR-44/AR-47 — the one place this feature's email copy is
 * assembled. `next-intl`'s `createTranslator` is the same ICU translation
 * engine `getTranslations` gives a Server Component, used directly here
 * because an email is rendered by a worker handler with no request and no
 * React tree to attach a Server Component translator to — `createTranslator`
 * is exactly the part of next-intl that does not need either.
 *
 * BR-018-18 / human review recorded in the PR: every string in the `email`
 * catalogue namespace below states which of the *user's own* rules matched —
 * "no seu limite de compra de R$ 30,00" — never "recomendamos", "hora de
 * comprar" or any other wording that reads as the product's own judgement.
 * `notAdvice` says so explicitly, once, in every message this function sends.
 *
 * BR-018-28: the only fields this function ever touches are `alert`'s own —
 * the asset, its price, the user's own threshold and the resulting state —
 * and `unsubscribeUrl`. There is no path from here to a CPF, a position size
 * or a portfolio value: `OpportunityAlert` (`core/opportunity/ports.ts`)
 * cannot carry any of the three, so this function could not render them even
 * if it tried. `tests/integration/opportunity-email.test.ts` scans the actual
 * rendered output rather than trusting that description (AC-17).
 */

export interface RenderedOpportunityEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Minimal, defensive — asset codes/names come from our own catalog, never user free text, but this is cheap insurance in an HTML body. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderOpportunityEmail(
  alert: OpportunityAlert,
  unsubscribeUrl: string,
): RenderedOpportunityEmail {
  const t = createTranslator({ locale: DEFAULT_LOCALE, messages, namespace: 'email.opportunity' });

  const stateLabel = t(`stateLabel.${alert.state}`);
  const price = formatCurrency(alert.price);
  const quotedAt = formatDateTime(alert.quotedAt);

  // BR-018-12/DL-018-02: `alert.threshold` is `null` exactly when the
  // *default* band matched (`ports.ts`'s own doc comment) — branching on the
  // null check directly, rather than on `alert.matched`, is what lets
  // TypeScript narrow `alert.threshold` to `Money` inside the `else` branch
  // with no cast and no `!` (DV-03).
  let subject: string;
  let body: string;
  if (alert.threshold === null) {
    subject = t('subjectDefault', { assetCode: alert.assetCode });
    body = t('bodyDefault', {
      assetCode: alert.assetCode,
      assetName: alert.assetName,
      price,
      stateLabel,
    });
  } else {
    const threshold = formatCurrency(alert.threshold);
    subject = t('subjectBound', { assetCode: alert.assetCode, stateLabel });
    body = t('bodyBound', {
      assetCode: alert.assetCode,
      assetName: alert.assetName,
      price,
      stateLabel,
      threshold,
    });
  }

  const quoteMeta = t('quoteMeta', { quotedAt, source: alert.source });
  const delayDisclosure = t('delayDisclosure', { minutes: alert.delayMinutes });
  const notAdvice = t('notAdvice');
  const unsubscribeLinkText = t('unsubscribeLinkText');

  const text = [
    body,
    quoteMeta,
    delayDisclosure,
    notAdvice,
    '',
    `${unsubscribeLinkText}: ${unsubscribeUrl}`,
  ].join('\n\n');

  const html = [
    `<p>${escapeHtml(body)}</p>`,
    `<p>${escapeHtml(quoteMeta)}</p>`,
    `<p>${escapeHtml(delayDisclosure)}</p>`,
    `<p>${escapeHtml(notAdvice)}</p>`,
    `<p><a href="${escapeHtml(unsubscribeUrl)}">${escapeHtml(unsubscribeLinkText)}</a></p>`,
  ].join('\n');

  return { subject, text, html };
}
