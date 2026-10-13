import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildNegociacaoXlsx } from '@/adapters/ingestion/xlsx/test-support/builder';
import { expect, test } from './support/authenticated';

/**
 * SPEC-022 BR-022-16/18/31, DL-022-12 (#211) — Configurações › Importar.
 *
 * The defect this section exists to fix: on the owner's screens more than
 * twenty history rows sat between the upload and the B3 export guide, so the
 * guide was unreachable without scrolling to the bottom. The history is seeded
 * at three hundred batches here — the AC's own number — rather than a handful,
 * because the failure only shows at volume.
 *
 * Batches are inserted directly, as `support/onboarding.ts` does: no file is
 * involved, so nothing here is a B3 extract (DV-24, TS-19). The upload journey
 * itself is `import.spec.ts`'s.
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

const HISTORY_SIZE = 300;

/**
 * `HISTORY_SIZE` committed Negociação batches, one a minute apart going back
 * from now, the n-th newest having read n rows — so newest-first and
 * fewest-rows-first are different orders — plus one batch in each other status.
 */
async function seedHistory(userId: string): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at, row_counts)
       SELECT gen_random_uuid(), $1, 'b3_negociacao', 'committed',
              now() - make_interval(mins => n), now() - make_interval(mins => n),
              jsonb_build_object('read', n, 'new', n, 'duplicates', 0, 'needsAttention', 0,
                                 'ignored', 0, 'fromDate', null, 'toDate', null)
         FROM generate_series(1, $2::int) AS n`,
      [userId, HISTORY_SIZE],
    );
    for (const [status, counts] of [
      ['pending', null],
      ['previewed', { read: 7, new: 7, duplicates: 0, needsAttention: 0, ignored: 0 }],
      ['discarded', null],
      ['failed', null],
    ] as const) {
      await pool.query(
        `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, row_counts, failure_code)
         VALUES ($1, $2, 'b3_movimentacao', $3, now() - interval '2 days', $4, $5)`,
        [
          randomUUID(),
          userId,
          status,
          counts === null ? null : JSON.stringify(counts),
          status === 'failed' ? 'INGESTION_UNRECOGNIZED_STRUCTURE' : null,
        ],
      );
    }
  } finally {
    await pool.end();
  }
}

test.describe('Configurações › Importar', () => {
  test('with 300 imports, Enviar shows the upload and the export guide and no history', async ({
    signedIn,
    viewport,
  }) => {
    const { page, userId } = signedIn;
    await seedHistory(userId);

    await page.goto('/settings/import');

    await expect(page.getByRole('heading', { level: 1, name: 'Configurações' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Enviar' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Nothing of the history is on this tab, at any count.
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByText('Importado', { exact: true })).toHaveCount(0);

    const guide = page.getByRole('heading', { name: /como exportar/i });
    await expect(page.locator('[data-slot="file-upload"]')).toBeInViewport();
    // BR-022-16 — beside the upload, so both are on screen together. The two
    // halves need a ~42rem content column (`Split side="even"`), which the
    // frame leaves from roughly a 1225px viewport; narrower, they stack, upload
    // first (DL-12), and the guide follows it directly.
    if ((viewport?.width ?? 0) >= 1280) {
      await expect(guide).toBeInViewport();
      const upload = await page.locator('[data-slot="file-upload"]').boundingBox();
      const heading = await guide.boundingBox();
      expect(heading!.x).toBeGreaterThan(upload!.x + upload!.width);
    } else {
      await expect(guide).toBeVisible();
    }
  });

  test('Histórico pages, sorts, and shows each status in its own colour', async ({
    signedIn,
    viewport,
  }) => {
    // Below md the same rows render as cards (DS-28); paging and sorting there
    // are DataTable's own, covered by `data-table.spec.ts`.
    test.skip((viewport?.width ?? 0) < 768, 'the table rendering is desktop-only');
    const { page, userId } = signedIn;
    await seedHistory(userId);

    await page.goto('/settings/import/history');
    const table = page.getByRole('table', { name: /Histórico de importações/ });
    const bodyRows = table.locator('tbody tr');

    // BR-022-18 — bounded, with the total stated.
    await expect(bodyRows).toHaveCount(25);
    await expect(page.getByText(`Mostrando 1–25 de ${HISTORY_SIZE + 4} importações`)).toBeVisible();

    // Newest first: the batch sent a minute ago read one row.
    await expect(bodyRows.first().locator('td').nth(3)).toHaveText('1');

    await page.getByRole('button', { name: 'Próxima página' }).click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await expect(bodyRows.first().locator('td').nth(3)).toHaveText('26');

    // Sorting by Linhas, descending — a numeric column's first click — puts
    // the 300-row batch on top.
    await page.getByRole('button', { name: 'Ordenar por Linhas' }).click();
    await expect(table.getByRole('columnheader', { name: /Linhas/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await expect(bodyRows.first().locator('td').nth(3)).toHaveText(String(HISTORY_SIZE));

    // BR-022-31 — the four non-committed statuses, filtered to by their label.
    const expected = {
      'Enviado, processando': 'progress',
      'Aguardando confirmação': 'warning',
      Cancelado: 'neutral',
      'Não foi possível processar': 'danger',
      Importado: 'success',
    } as const;
    for (const [label, variant] of Object.entries(expected)) {
      await page.getByRole('searchbox').fill(label);
      const badge = table.locator('[data-slot="badge"]', { hasText: label }).first();
      await expect(badge).toHaveAttribute('data-variant', variant);
    }

    // A batch that never got past detection does not claim a type.
    await page.getByRole('searchbox').fill('Não foi possível processar');
    await expect(bodyRows).toHaveCount(1);
    await expect(bodyRows.first()).toContainText('Não identificado');

    await bodyRows
      .first()
      .getByRole('link', { name: /Ver detalhes/ })
      .click();
    await expect(page).toHaveURL(/\/settings\/import\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Não foi possível processar este arquivo')).toBeVisible();
    await page.getByRole('link', { name: 'Histórico de importações' }).click();
    await expect(page).toHaveURL(/\/settings\/import\/history/);
  });

  test('Configurações lists Importar in its sub-navigation, and the sidebar no longer does', async ({
    signedIn,
    viewport,
  }) => {
    const { page } = signedIn;
    await page.goto('/settings/import/parameters');

    const subNav = page.getByRole('navigation', { name: 'Seções de Configurações' });
    await expect(subNav.getByRole('link', { name: 'Importar' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    if ((viewport?.width ?? 0) >= 768) {
      const sidebar = page.getByRole('navigation', { name: 'Navegação' });
      await expect(sidebar.getByRole('link', { name: 'Importar' })).toHaveCount(0);
    }
  });

  /**
   * BR-022-18 — a batch's row tables page on the server, so a long Precisa de
   * atenção is bounded and pages without JavaScript. Sixty sales of a position
   * with no history are each refused at commit (BR-005-24): sixty rows needing
   * attention, from a generated file.
   */
  test('a batch page pages its rows needing attention', async ({ signedIn, viewport }) => {
    test.setTimeout(180_000);
    test.skip((viewport?.width ?? 0) < 768, 'one viewport is enough for a server-side pager');
    const { page } = signedIn;

    const file = await buildNegociacaoXlsx(
      Array.from({ length: 60 }, (_, index) => ({
        data: `${String((index % 28) + 1).padStart(2, '0')}/0${Math.floor(index / 28) + 1}/2026`,
        tipo: 'Venda',
        codigo: 'VALE3',
        quantidade: String(index + 1),
        preco: '61,00',
      })),
    );
    await page.goto('/settings/import');
    await page.locator('input[type="file"][name="file"]').setInputFiles({
      name: 'negociacao.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(file),
    });
    await page.getByRole('button', { name: /^enviar$/i }).click();
    await expect(page).toHaveURL(/\/settings\/import\/[0-9a-f-]{36}$/);

    const confirm = page.getByRole('button', { name: /confirmar importação/i });
    await expect(async () => {
      await page.reload();
      await expect(confirm).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 90_000 });
    await confirm.click();

    const attention = page.getByRole('table', { name: 'Precisa de atenção' });
    await expect(async () => {
      await page.reload();
      await expect(attention.locator('tbody tr')).toHaveCount(50, { timeout: 1_000 });
    }).toPass({ timeout: 90_000 });

    const pager = page.getByRole('navigation', { name: 'Paginação de Precisa de atenção' });
    await expect(pager).toContainText('Página 1 de 2 · 60 linha(s)');
    await pager.getByRole('link', { name: 'Próxima' }).click();
    await expect(page).toHaveURL(/[?&]atencao=2#attention$/);
    await expect(attention.locator('tbody tr')).toHaveCount(10);

    // Back to page 1 keeps the table's parameter (#230 review): Ignoradas is
    // opened by it, and a page-1 link that dropped it would collapse the rows.
    await pager.getByRole('link', { name: 'Anterior' }).click();
    await expect(page).toHaveURL(/[?&]atencao=1#attention$/);
    await expect(attention.locator('tbody tr')).toHaveCount(50);
  });
});

// SPEC-022 BR-022-36: a table owns one panel, including its pagination band.
test('history rows stay flat and pagination spans the panel', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  await seedHistory(userId);
  await page.goto('/settings/import/history');
  const panel = page
    .locator('[data-variant="panel"]')
    .filter({ has: page.locator('[data-slot="data-table"]') });
  await expect(panel).toHaveCount(1);
  await expect(panel.locator('[data-slot="card"]')).toHaveCount(0);
  const footer = panel.locator('[data-slot="table-footer"]');
  await expect(footer).toBeVisible();
  const panelBox = await panel.boundingBox();
  const footerBox = await footer.boundingBox();
  expect(Math.abs(panelBox!.width - footerBox!.width)).toBeLessThan(2);
  expect(Math.abs(panelBox!.y + panelBox!.height - footerBox!.y - footerBox!.height)).toBeLessThan(
    2,
  );
  expect(await footer.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('1px');
});
