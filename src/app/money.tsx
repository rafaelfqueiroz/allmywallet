import { Money as MoneyFigure, type MoneyProps } from '@/components/patterns/money';
import { useHideValues } from '@/app/hide-values';

/**
 * `Money` as every page renders it: the design-system figure, with the
 * account's masking preference applied on the server (SPEC-022 BR-022-24/25).
 *
 * Pages import this one rather than `@/components/patterns/money`, and
 * `tests/structural/amounts-are-masked.test.ts` holds them to it — a figure
 * rendered from the pattern directly is a figure the eye toggle cannot hide.
 * The pattern stays free of the session and the registry (DS-02); this is the
 * one place the two meet, the same way `authenticated-frame.tsx` wires the
 * account menu.
 */
export function Money(props: Omit<MoneyProps, 'masked'>) {
  return <MoneyFigure {...props} masked={useHideValues()} />;
}
