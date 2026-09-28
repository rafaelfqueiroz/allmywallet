import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import { failure, IDLE, type ActionState } from '@/lib/action-state';
import { audit, render, screen } from '@/components/test-utils';
import { SubscriptionOfferPanel, type SubscriptionOfferLabels } from './SubscriptionOfferPanel';

/**
 * SPEC-005 BR-005-20d (#157, DL-005-25) / BR-006-15.
 *
 * As `ClassifyForm.test.tsx` does for its own form: `resolveSubscriptionOffer`
 * and `keepSubscriptionClassification` are not called here — they need a
 * tenant database (TS-02) — what is proven is the panel's own contract. A
 * fake action stands in, the same technique `action-form.test.tsx` and
 * `ClassifyForm.test.tsx` both use.
 */
const withClose: SubscriptionOfferLabels = {
  pairing:
    'Esta linha é o exercício de uma subscrição cujo crédito — 7 HGLG11 em 02/09/2021 — você classificou como Bonificação, a custo zero.',
  priceHint:
    'Resolver como subscrição vai precificá-lo pelo fechamento de 02/09/2021 (R$ 114,90), marcado como estimativa.',
  closeMissingReason: null,
  estimateBadge: 'Preço estimado',
  resolve: 'Resolver como subscrição',
  keep: 'Manter minha classificação',
};

const withoutClose: SubscriptionOfferLabels = {
  ...withClose,
  priceHint: null,
  closeMissingReason:
    'Ainda não há um preço de fechamento guardado para essa data. Importe a Movimentação de novo para buscá-lo.',
};

describe('SubscriptionOfferPanel', () => {
  it('explains the pairing and offers both actions, with the estimate visibly marked', () => {
    render(
      <SubscriptionOfferPanel
        rowId="row-1"
        resolveAction={async () => IDLE}
        keepAction={async () => IDLE}
        labels={withClose}
      />,
    );

    expect(screen.getByText(withClose.pairing)).toBeInTheDocument();
    expect(screen.getByText(/marcado como estimativa/)).toBeInTheDocument();
    expect(screen.getByText('Preço estimado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolver como subscrição' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Manter minha classificação' })).toBeEnabled();
  });

  it('disables "Resolver como subscrição" and shows why, with no stored close (D1)', () => {
    render(
      <SubscriptionOfferPanel
        rowId="row-1"
        resolveAction={async () => IDLE}
        keepAction={async () => IDLE}
        labels={withoutClose}
      />,
    );

    expect(screen.getByRole('button', { name: 'Resolver como subscrição' })).toBeDisabled();
    expect(screen.getByText(withoutClose.closeMissingReason as string)).toBeInTheDocument();
    // No estimate to mark yet, so no badge either.
    expect(screen.queryByText('Preço estimado')).not.toBeInTheDocument();
    // "Keep my classification" needs no price and stays available.
    expect(screen.getByRole('button', { name: 'Manter minha classificação' })).toBeEnabled();
  });

  it('submits only the row id for each action', async () => {
    const resolveSubmitted: FormData[] = [];
    const keepSubmitted: FormData[] = [];
    const resolveAction = async (_state: ActionState, formData: FormData): Promise<ActionState> => {
      resolveSubmitted.push(formData);
      return IDLE;
    };
    const keepAction = async (_state: ActionState, formData: FormData): Promise<ActionState> => {
      keepSubmitted.push(formData);
      return IDLE;
    };
    render(
      <SubscriptionOfferPanel
        rowId="row-42"
        resolveAction={resolveAction}
        keepAction={keepAction}
        labels={withClose}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Resolver como subscrição' }));
    expect(resolveSubmitted).toHaveLength(1);
    expect((resolveSubmitted[0] as FormData).get('rowId')).toBe('row-42');

    await userEvent.click(screen.getByRole('button', { name: 'Manter minha classificação' }));
    expect(keepSubmitted).toHaveLength(1);
    expect((keepSubmitted[0] as FormData).get('rowId')).toBe('row-42');
  });

  it('shows a refusal either action returns, rather than swallowing it (BR-006-15)', async () => {
    const refuses = async (): Promise<ActionState> =>
      failure({ code: IngestionUseCaseErrorCode.SUBSCRIPTION_OFFER_UNAVAILABLE, context: {} });
    render(
      <SubscriptionOfferPanel
        rowId="row-1"
        resolveAction={refuses}
        keepAction={async () => IDLE}
        labels={withClose}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Resolver como subscrição' }));

    // The catalogue's own pt-BR message (AR-38) — not the raw code.
    expect(await screen.findByText(/não está mais disponível/)).toBeInTheDocument();
  });

  it('is accessible in both the priced and the close-missing state', async () => {
    const { container: priced } = render(
      <SubscriptionOfferPanel
        rowId="row-1"
        resolveAction={async () => IDLE}
        keepAction={async () => IDLE}
        labels={withClose}
      />,
    );
    expect(await audit(priced)).toHaveNoViolations();

    const { container: missing } = render(
      <SubscriptionOfferPanel
        rowId="row-2"
        resolveAction={async () => IDLE}
        keepAction={async () => IDLE}
        labels={withoutClose}
      />,
    );
    expect(await audit(missing)).toHaveNoViolations();
  });
});
