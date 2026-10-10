/**
 * SPEC-022 BR-022-24/25 — a chart's coordinates, with the amounts taken out.
 *
 * A chart is a Client Component, so its series crosses to the browser as plain
 * numbers inside the page's own HTML (the RSC payload). Masking the axis and
 * the tooltip hides what is *painted*, but those numbers would still be the
 * amounts, one "view source" away — and BR-022-25 is about the HTML, not about
 * what CSS or a formatter chooses to show.
 *
 * So when masking is on, every money key of every row is divided by the
 * largest magnitude among them and multiplied by 100. Ratios between points
 * are what a shape *is*, so the chart draws exactly the same picture — the
 * same bars, the same stack, the same flat goal line, the same sign below
 * zero — on a 0–100 scale that is no amount at all. `null` (a gap) stays
 * `null`, and keys that are not money (dates, labels) are untouched.
 *
 * Known limit, DL-022-07's own: relative sizes are still there, as they are in
 * the picture itself. One amount learned elsewhere scales the rest back.
 * Masking defends against a glance, not against inspection.
 */
export function concealSeries<Row extends object>(
  rows: readonly Row[],
  keys: readonly (keyof Row)[],
  masked: boolean,
): Row[] {
  if (!masked) return [...rows];

  let largest = 0;
  for (const row of rows) {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === 'number') largest = Math.max(largest, Math.abs(value));
    }
  }
  // An all-zero (or empty) series has no amount to hide, and dividing by zero
  // would turn every point into NaN — which Recharts silently drops.
  if (largest === 0) return [...rows];

  const scale = 100 / largest;
  return rows.map((row) => {
    const next = { ...row };
    for (const key of keys) {
      const value = row[key];
      if (typeof value === 'number') {
        // Two decimals of a 0–100 scale is finer than a pixel on any chart here.
        next[key] = (Math.round(value * scale * 100) / 100) as Row[typeof key];
      }
    }
    return next;
  });
}
