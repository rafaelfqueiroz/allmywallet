import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('merges conflicting Tailwind utilities, last one winning', () => {
    // The reason this helper exists rather than template strings: `clsx` alone
    // would emit both padding classes and leave the winner to source order.
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('drops falsy branches', () => {
    const isHidden = Math.min(0, 1) > 0;
    expect(cn('text-sm', isHidden && 'hidden', undefined, 'font-medium')).toBe(
      'text-sm font-medium',
    );
  });

  it('keeps utilities that do not conflict', () => {
    expect(cn('flex', 'items-center')).toBe('flex items-center');
  });
});
