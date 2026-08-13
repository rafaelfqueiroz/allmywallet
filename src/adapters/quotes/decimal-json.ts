/**
 * AR-06 — the boundary hazard named explicitly in the spec dispatch: a quote
 * arrives over HTTP as JSON, and `Response.json()` (or `JSON.parse`) turns
 * every numeric literal into an IEEE-754 `number` *before* any application
 * code sees it. Wrapping that number in `Money` afterwards is already too
 * late — the precision loss (if any) already happened, and worse, it makes
 * "parse a provider price" look identical to the `Money.unsafeFromNumber`
 * escape hatch that is supposed to be test/seed-only.
 *
 * The fix used by every adapter in this directory: read the response as
 * **text**, and pull the specific money field out with a regex that captures
 * the literal decimal digits as a string, never letting them pass through a
 * `number`. The rest of the payload (symbol, timestamps) is parsed normally
 * with `JSON.parse`/Zod — this precision hazard is specific to money fields.
 */
export function extractJsonDecimalField(rawBody: string, fieldName: string): string | null {
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
  const match = pattern.exec(rawBody);
  return match?.[1] ?? null;
}
