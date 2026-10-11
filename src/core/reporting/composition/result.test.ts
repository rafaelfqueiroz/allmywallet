import { describe, expect, it } from 'vitest';
import { money } from '@/core/reporting/test-support';
import { unrealizedResult } from '@/core/reporting/composition/result';

/**
 * SPEC-015 BR-015-08 at the grain of a total (SPEC-022 BR-022-02/34).
 * Hand-computed (TS-04): every expected figure below is worked by hand, not
 * re-derived through `Money`.
 */
describe('unrealizedResult', () => {
  it('is value minus cost, and that figure against the cost', () => {
    // 5.000,00 − 4.000,00 = 1.000,00; 1.000 ÷ 4.000 = 0,25.
    const { result, ratio } = unrealizedResult({
      value: money('5000'),
      costBasis: money('4000'),
    });
    expect(result.toString()).toBe('1000');
    expect(ratio?.toString()).toBe('0.25');
  });

  it('keeps the sign of a loss on both figures', () => {
    // 3.000,00 − 4.000,00 = −1.000,00; −1.000 ÷ 4.000 = −0,25.
    const { result, ratio } = unrealizedResult({
      value: money('3000'),
      costBasis: money('4000'),
    });
    expect(result.toString()).toBe('-1000');
    expect(ratio?.toString()).toBe('-0.25');
  });

  it('has no ratio on a zero cost — a result on nothing is undefined, not infinite', () => {
    const { result, ratio } = unrealizedResult({ value: money('100'), costBasis: money('0') });
    expect(result.toString()).toBe('100');
    expect(ratio).toBeNull();
  });

  it('has no ratio on a negative cost, which would read a gain as a loss', () => {
    // 100 − (−50) = 150; 150 ÷ −50 would be −3, a "loss" on a gain.
    const { result, ratio } = unrealizedResult({ value: money('100'), costBasis: money('-50') });
    expect(result.toString()).toBe('150');
    expect(ratio).toBeNull();
  });
});
