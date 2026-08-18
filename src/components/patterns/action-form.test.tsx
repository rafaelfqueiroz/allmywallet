import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { ActionForm } from '@/components/patterns/action-form';
import { Button } from '@/components/ui/button';
import { WalletErrorCode } from '@/core/wallets/errors';
import { failure, IDLE, type ActionState } from '@/lib/action-state';
import { audit, render, screen } from '@/components/test-utils';

/**
 * SPEC-010 AC-4 / BR-010-05 — "allocating more than the held quantity is
 * refused at write time".
 *
 * The rule's entire observable behaviour is the refusal, and every wallet
 * action used to end `if (isErr(result)) return;`: the domain refused, the
 * action returned `void`, and the page came back unchanged. Indistinguishable
 * from success, so the user's next move is to submit the same thing again.
 */
describe('ActionForm — a refused write says so (#63)', () => {
  const refuses = async (): Promise<ActionState> =>
    failure({
      code: WalletErrorCode.ALLOCATION_EXCEEDS_HOLDINGS,
      context: { held: '100', requested: '150' },
    });

  it('renders the domain refusal through the errors catalogue', async () => {
    render(
      <ActionForm action={refuses}>
        <Button type="submit">Atribuir</Button>
      </ActionForm>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Atribuir' }));

    // The message is the catalogue's, resolved from the code — not a string
    // the component invented (AR-38). Asserting on the held quantity proves
    // the *context* crossed the action boundary too, which is what makes the
    // message tell a user what the ceiling actually is.
    const alert = await screen.findByText(/100/);
    expect(alert).toBeInTheDocument();
  });

  it('shows nothing before the action has run', () => {
    const { container } = render(
      <ActionForm action={refuses}>
        <Button type="submit">Atribuir</Button>
      </ActionForm>,
    );
    expect(container.querySelector('[data-slot="error-state"]')).toBeNull();
  });

  it('a successful action leaves no error behind', async () => {
    render(
      <ActionForm action={async () => IDLE}>
        <Button type="submit">Atribuir</Button>
      </ActionForm>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(screen.queryByText(/100/)).toBeNull();
  });

  it('is accessible with the refusal on screen', async () => {
    const { container } = render(
      <ActionForm action={refuses}>
        <Button type="submit">Atribuir</Button>
      </ActionForm>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Atribuir' }));
    await screen.findByText(/100/);
    expect(await audit(container)).toHaveNoViolations();
  });
});
