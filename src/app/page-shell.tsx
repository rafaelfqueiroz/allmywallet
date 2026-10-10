import { PageShell as Shell, type PageShellProps } from '@/components/patterns/page-shell';
import { MaskingSync } from '@/components/patterns/masking';
import { useHideValues } from '@/app/hide-values';

/**
 * `PageShell` as every signed-in page renders it: the pattern, plus a report
 * of the masking this page was rendered with (SPEC-022 BR-022-24/25).
 *
 * The eye toggle lives in the frame, a layout, which a client-side navigation
 * does not re-render. Masking switched in another tab or on another device
 * would leave the eye showing the old state over a page rendered with the new
 * one. Every page renders this shell, so every page tells the frame what it
 * rendered — `tests/structural/one-page-width.test.ts` already requires the
 * shell and `tests/structural/amounts-are-masked.test.ts` requires this one.
 *
 * The read is the request-cached one `Money` uses, so it costs nothing extra.
 */
export function PageShell(props: PageShellProps) {
  return (
    <>
      <MaskingSync masked={useHideValues()} />
      <Shell {...props} />
    </>
  );
}
