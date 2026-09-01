import { describe, expect, it } from 'vitest';
import { audit, render, screen, userEvent, within } from '@/components/test-utils';
import {
  HoldingsTable,
  type Cell,
  type HoldingRow,
  type HoldingsTableLabels,
} from '@/app/(app)/reports/composition/_components/HoldingsTable';

/**
 * SPEC-015 AC-4 — "the table sorts by every column, ascending and descending",
 * and AC "at wallet scope a partially-allocated asset shows the allocated
 * quantity" is asserted one layer down, in `report.test.ts`, where the figures
 * are still `Money`.
 *
 * What is checked **here** is the half that only exists on this side of the
 * serialisation boundary: that ordering by an integer rank reproduces the
 * ordering of the figures it was ranked from, and that a row with no figure
 * does not sort as though it had a zero.
 */

const labels: HoldingsTableLabels = {
  code: 'Ativo',
  state: 'Estado',
  assetClass: 'Classe',
  sector: 'Setor',
  quantity: 'Quantidade',
  averagePrice: 'Preço médio',
  currentPrice: 'Preço atual',
  value: 'Valor',
  share: 'Participação',
  unrealizedGain: 'Ganho não realizado',
  caption: 'Ativos do escopo selecionado',
  concentrated: 'Acima de 20%',
  concentratedTitle: 'Marcação informativa, sem recomendação.',
  estimated: 'Estimado',
  estimatedTitle: 'Valor estimado, não observado no mercado.',
  sortBy: 'Ordenar por {column}',
  sortField: 'Ordenar por',
  sortAscending: 'Ordem crescente',
  sortDescending: 'Ordem decrescente',
};

const cell = (text: string, rank: number | undefined, negative = false): Cell => ({
  text,
  rank,
  negative,
});

/**
 * Three holdings, ranked the way the server would rank them:
 *
 *   value          HGLG11 1.000 (2) · ITSA4 600 (1) · CDBX 400 (0)
 *   unrealizedGain HGLG11   +100 (2) · ITSA4 −50 (0) · CDBX  +10 (1)
 *
 * CDBX has **no average price and no share** — the two absences a real report
 * produces, from a zero quantity and a zero scope total.
 */
const rows: readonly HoldingRow[] = [
  {
    id: 'a-1',
    code: 'HGLG11',
    name: 'CSHG Logística',
    assetClass: 'FIIs',
    sector: 'Logística',
    quantity: cell('5', 1),
    averagePrice: cell('R$ 180,00', 1),
    currentPrice: cell('R$ 200,00', 1),
    value: cell('R$ 1.000,00', 2),
    share: cell('50,00%', 1),
    unrealizedGain: cell('R$ 100,00', 2),
    concentrated: true,
    estimated: false,
    // SPEC-018 BR-018-19 — watched, with a usable quote.
    opportunityState: 'buy',
    opportunityStateLabel: 'compra',
    opportunityStateTitle: 'Estado da sua própria regra.',
  },
  {
    id: 'a-2',
    code: 'ITSA4',
    name: 'Itaúsa PN',
    assetClass: 'Ações',
    sector: 'Bancos',
    quantity: cell('100', 2),
    averagePrice: cell('R$ 6,50', 0),
    currentPrice: cell('R$ 6,00', 0),
    value: cell('R$ 600,00', 1),
    share: cell('30,00%', 0),
    unrealizedGain: cell('−R$ 50,00', 0, true),
    concentrated: true,
    estimated: false,
    // BR-018-16 — watched, but no usable quote: still a badge, deliberately.
    opportunityState: 'unknown',
    opportunityStateLabel: 'sem cotação válida',
    opportunityStateTitle: 'A cotação está ausente ou desatualizada demais.',
  },
  {
    id: 'a-3',
    code: 'CDBX',
    name: 'CDB Banco X',
    assetClass: 'CDB',
    sector: 'Não classificado',
    quantity: cell('1', 0),
    averagePrice: cell('—', undefined),
    currentPrice: cell('R$ 400,00', 2),
    value: cell('R$ 400,00', 0),
    share: cell('—', undefined),
    unrealizedGain: cell('R$ 10,00', 1),
    // BR-018-02 — a CDB has no market price and can never carry a rule, so
    // there is no state to show. `null` is the absence of a rule, which is
    // not the same as `unknown` (a rule whose price cannot be read).
    opportunityState: null,
    opportunityStateLabel: '',
    opportunityStateTitle: '',
    concentrated: false,
    estimated: true,
  },
];

function table() {
  return screen.getByRole('table');
}

function column(header: string): (string | undefined)[] {
  const headers = within(table()).getAllByRole('columnheader');
  const index = headers.findIndex((cellNode) => cellNode.textContent?.includes(header));
  return within(table())
    .getAllByRole('row')
    .slice(1)
    .map((row) => stripBadges(within(row).getAllByRole('cell')[index]?.textContent));
}

/**
 * The Ativo cell carries its badges in the same text node. They are asserted
 * on their own below, so they are stripped here rather than baked into every
 * expected order.
 */
function stripBadges(text: string | null | undefined): string | undefined {
  return text?.replace(labels.concentrated, '').replace(labels.estimated, '');
}

async function sortBy(header: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(within(table()).getByRole('button', { name: `Ordenar por ${header}` }));
}

describe('HoldingsTable — SPEC-015 AC-4', () => {
  it('opens largest-first, the order the domain folded the rows in', () => {
    render(<HoldingsTable rows={rows} labels={labels} />);
    expect(column('Ativo')).toEqual(['HGLG11', 'ITSA4', 'CDBX']);
  });

  /**
   * A money column opens **descending** — largest first is what somebody
   * clicking "Valor" on their own portfolio is asking for, and the component
   * says so explicitly rather than inheriting it from TanStack's numeric
   * inference. `Valor` is the column the table already opens sorted on, so its
   * first click is the toggle to ascending.
   */
  it.each([
    ['Quantidade', ['ITSA4', 'HGLG11', 'CDBX']],
    ['Preço atual', ['CDBX', 'HGLG11', 'ITSA4']],
    ['Ganho não realizado', ['HGLG11', 'CDBX', 'ITSA4']],
  ])('sorts descending by %s on the first click', async (header, expected) => {
    render(<HoldingsTable rows={rows} labels={labels} />);
    await sortBy(header);
    expect(column('Ativo')).toEqual(expected);
  });

  it.each([
    ['Quantidade', ['CDBX', 'HGLG11', 'ITSA4']],
    ['Preço atual', ['ITSA4', 'HGLG11', 'CDBX']],
    ['Ganho não realizado', ['ITSA4', 'CDBX', 'HGLG11']],
  ])('and ascending on the second', async (header, expected) => {
    render(<HoldingsTable rows={rows} labels={labels} />);
    await sortBy(header);
    await sortBy(header);
    expect(column('Ativo')).toEqual(expected);
  });

  it('toggles the column it opened on, rather than re-applying it', async () => {
    render(<HoldingsTable rows={rows} labels={labels} />);
    await sortBy('Valor');
    expect(column('Ativo')).toEqual(['CDBX', 'ITSA4', 'HGLG11']);
    await sortBy('Valor');
    expect(column('Ativo')).toEqual(['HGLG11', 'ITSA4', 'CDBX']);
  });

  it('sorts the text columns too', async () => {
    render(<HoldingsTable rows={rows} labels={labels} />);
    await sortBy('Classe');
    expect(column('Classe')).toEqual(['Ações', 'CDB', 'FIIs']);
  });

  it('keeps a row with no figure at the bottom in **both** directions', async () => {
    /**
     * CDBX has no average price. An absent figure is not the smallest value,
     * it is the absence of one — letting it sort as zero would put it above
     * every real price ascending and bury a real price descending, and in
     * neither case would the reader be able to tell.
     */
    render(<HoldingsTable rows={rows} labels={labels} />);

    await sortBy('Preço médio');
    expect(column('Ativo')).toEqual(['HGLG11', 'ITSA4', 'CDBX']);

    await sortBy('Preço médio');
    expect(column('Ativo')).toEqual(['ITSA4', 'HGLG11', 'CDBX']);
  });

  it('BR-015-05/06: the concentration marker states the threshold and recommends nothing', () => {
    render(<HoldingsTable rows={rows} labels={labels} />);
    const badges = within(table()).getAllByText('Acima de 20%');

    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]).toHaveAttribute('title', 'Marcação informativa, sem recomendação.');
  });

  it('BR-015-09: marks the accrued row and only that one', () => {
    render(<HoldingsTable rows={rows} labels={labels} />);
    // Both renderings of the row are in the DOM (DL-12), so one row yields two.
    expect(screen.getAllByText('Estimado')).toHaveLength(2);
  });

  it('has no axe violations', async () => {
    const { container } = render(<HoldingsTable rows={rows} labels={labels} />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

/**
 * DL-12 renders the rows as cards below `md`, which removes every column
 * header — and with them the only way to sort. A phone is where a holdings
 * list is most likely to be long enough to need it, so the affordance is
 * rebuilt rather than dropped.
 *
 * jsdom applies no CSS, so both renderings are in the DOM here and both are
 * queryable; the E2E suite is what proves each is the one actually shown at
 * its own viewport.
 */
function cardCodes(): (string | undefined)[] {
  return within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map((item) => stripBadges(within(item).getAllByRole('definition')[0]?.textContent));
}

describe('HoldingsTable — sorting without column headers', () => {
  it('offers every sortable column in the card rendering control', () => {
    render(<HoldingsTable rows={rows} labels={labels} />);
    const select = screen.getByLabelText('Ordenar por');

    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Ativo',
      'Classe',
      'Setor',
      'Estado',
      'Quantidade',
      'Preço médio',
      'Preço atual',
      'Valor',
      'Participação',
      'Ganho não realizado',
    ]);
  });

  it('re-orders the cards when a column is chosen', async () => {
    const user = userEvent.setup();
    render(<HoldingsTable rows={rows} labels={labels} />);

    expect(cardCodes()).toEqual(['HGLG11', 'ITSA4', 'CDBX']);

    await user.selectOptions(screen.getByLabelText('Ordenar por'), 'quantity');
    // The control keeps the current direction, which opens descending.
    expect(cardCodes()).toEqual(['ITSA4', 'HGLG11', 'CDBX']);
  });

  it('flips the direction, and says which one it is now in', async () => {
    const user = userEvent.setup();
    render(<HoldingsTable rows={rows} labels={labels} />);

    await user.click(screen.getByRole('button', { name: 'Ordem decrescente' }));
    expect(cardCodes()).toEqual(['CDBX', 'ITSA4', 'HGLG11']);
    expect(screen.getByRole('button', { name: 'Ordem crescente' })).toBeInTheDocument();
  });

  /**
   * SPEC-018 BR-018-19/BR-018-17 and DL-018-06 — the acceptance criterion
   * "every state is rendered with both a colour and a text label; an
   * automated check fails the build if a state renders as colour alone" is
   * enforced twice: `StateBadge` makes `label` a required prop, so a
   * colour-only call site does not compile, and this asserts the text is
   * genuinely in the document rather than merely typed as required.
   */
  it('shows each watched holding’s state as text, not colour alone', () => {
    render(<HoldingsTable rows={rows} labels={labels} />);

    expect(screen.getAllByText('compra').length).toBeGreaterThan(0);
    expect(screen.getAllByText('sem cotação válida').length).toBeGreaterThan(0);
  });

  it('shows no state for a holding that carries no rule (BR-018-02)', () => {
    render(<HoldingsTable rows={rows} labels={labels} />);

    // CDBX is a CDB: BR-018-02 gives it no market price to watch, so its
    // Estado cell is empty rather than reading `unknown`, which would say
    // "watched, but the price cannot be read" about an asset nobody can
    // watch at all.
    expect(column('Estado')).toEqual(['compra', 'sem cotação válida', '']);
  });
});
