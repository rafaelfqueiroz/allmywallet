import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { render, screen, userEvent, within } from '@/components/test-utils';
import { BULK_FORM_ID } from '@/app/(app)/transactions/_components/BulkBar';
import { LedgerSelection, RowSelect } from './LedgerSelection';

/**
 * PR #234 review P1 — the table and the card list each carry a row's
 * checkbox. What posts must be what the visible rendering shows.
 */
function Ledger() {
  return (
    <>
      <LedgerSelection>
        <div data-testid="table">
          <RowSelect id="a" label="A" />
          <RowSelect id="b" label="B" />
        </div>
        <div data-testid="cards">
          <RowSelect id="a" label="A" />
          <RowSelect id="b" label="B" />
        </div>
      </LedgerSelection>
      <form id={BULK_FORM_ID} aria-label="bulk" />
    </>
  );
}

const posted = () =>
  new FormData(document.getElementById(BULK_FORM_ID) as HTMLFormElement).getAll('selected');

describe('LedgerSelection', () => {
  it('ticks both copies of a row together', async () => {
    const user = userEvent.setup();
    render(<Ledger />);
    await user.click(within(screen.getByTestId('table')).getByRole('checkbox', { name: 'A' }));
    expect(within(screen.getByTestId('cards')).getByRole('checkbox', { name: 'A' })).toBeChecked();
    expect(
      within(screen.getByTestId('cards')).getByRole('checkbox', { name: 'B' }),
    ).not.toBeChecked();
  });

  it('posts nothing for a row unticked in the other rendering', async () => {
    const user = userEvent.setup();
    render(<Ledger />);
    // Ticked in the table, then — after a resize — unticked on its card, and B ticked there.
    await user.click(within(screen.getByTestId('table')).getByRole('checkbox', { name: 'A' }));
    await user.click(within(screen.getByTestId('cards')).getByRole('checkbox', { name: 'A' }));
    await user.click(within(screen.getByTestId('cards')).getByRole('checkbox', { name: 'B' }));
    expect(new Set(posted())).toEqual(new Set(['b']));
  });

  it('empties when the bulk form resets after its action', async () => {
    const user = userEvent.setup();
    render(<Ledger />);
    await user.click(within(screen.getByTestId('table')).getByRole('checkbox', { name: 'A' }));
    fireEvent.reset(document.getElementById(BULK_FORM_ID) as HTMLFormElement);
    expect(posted()).toEqual([]);
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });
});
