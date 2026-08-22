import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-011 BR-011-06 / AC-1 — **"the same control, the same options, the same
 * semantics" on every report.**
 *
 * DL-011-02 is the reason this framework exists at all: four separate
 * implementations drift, the grouping options diverge, the period boundaries
 * stop matching, and eventually two reports disagree about the same number.
 * `totals-invariant.test.ts` catches the *arithmetic* half of that drift. This
 * catches the half that happens earlier and more quietly — a report page that
 * builds its own control bar, which nothing about the totals would reveal.
 *
 * A **scan, not a maintained list** — the same reasoning as
 * `tests/isolation/enumeration.test.ts`. The point is not to confirm today's
 * three report pages: it is that SPEC-014's Earnings report (#17), the fourth
 * one AC-1 counts and the one nobody has written yet, cannot ship with a
 * hand-rolled period selector without failing here first. A list would have to
 * be remembered; a scan cannot be forgotten.
 *
 * It checks *structure*, not behaviour: that each page renders the shared
 * component. What the control renders, and that a URL round-trips through it,
 * are asserted in `Controls`'s own tests, `src/lib/report-url-state.test.ts`
 * and `tests/integration/reporting-framework.test.ts`.
 */
describe('every report exposes the shared controls (SPEC-011 BR-011-06 / AC-1)', () => {
  const reportsDir = join(process.cwd(), 'src/app/(app)/reports');

  /**
   * Every `page.tsx` under the reports route group. `_components` is excluded
   * by construction — App Router pages are named `page.tsx` and nothing in a
   * private folder is one.
   */
  function reportPages(): string[] {
    if (!existsSync(reportsDir)) return [];
    const pages: string[] = [];
    for (const entry of readdirSync(reportsDir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || entry.name !== 'page.tsx') continue;
      pages.push(join(entry.parentPath ?? reportsDir, entry.name));
    }
    return pages;
  }

  const CONTROLS_IMPORT = /from\s+['"]@\/app\/\(app\)\/reports\/_components\/Controls['"]/;
  const CONTROLS_RENDERED = /<Controls[\s/>]/;

  it('finds the report pages to scan', () => {
    // Without this the suite would pass by scanning nothing — the failure mode
    // a structural test is most prone to, and the least visible.
    const pages = reportPages();
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.some((path) => path.endsWith(join('reports', 'page.tsx')))).toBe(true);
  });

  it('every report page renders the one shared control bar', () => {
    const offenders = reportPages().filter((path) => {
      const source = readFileSync(path, 'utf8');
      return !CONTROLS_IMPORT.test(source) || !CONTROLS_RENDERED.test(source);
    });

    expect(
      offenders,
      'a report page that does not render @/app/(app)/reports/_components/Controls has its own ' +
        'period, scope or grouping control — BR-011-06 requires one bar across all four reports',
    ).toEqual([]);
  });

  /**
   * The pattern has to fire on the shape a regression would actually take: a
   * page that imports the pieces and assembles a bar of its own. Without this,
   * a typo in either regex would leave the check passing over everything.
   */
  it('the scan would notice a page that rolled its own control bar', () => {
    const handRolled = `
      import { NativeSelect } from '@/components/ui/native-select';
      export default function Page() {
        return <form><NativeSelect name="period" /></form>;
      }
    `;
    expect(CONTROLS_IMPORT.test(handRolled)).toBe(false);
    expect(CONTROLS_RENDERED.test(handRolled)).toBe(false);

    const shared = `
      import { Controls } from '@/app/(app)/reports/_components/Controls';
      export default function Page() {
        return <Controls action="/reports" period={p} scope={s} grouping={g} wallets={w} />;
      }
    `;
    expect(CONTROLS_IMPORT.test(shared)).toBe(true);
    expect(CONTROLS_RENDERED.test(shared)).toBe(true);
  });
});
