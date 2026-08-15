import type { ReactElement, ReactNode } from 'react';
import { render as rtlRender, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { axe } from 'vitest-axe';
import messages from '@/i18n/messages/pt-BR.json';

/**
 * Primitives render inside the app's real i18n provider with the real pt-BR
 * catalogue — not a stub. AR-44 says components hold no string literals, which
 * only means anything if the key they *do* use resolves. A missing key fails
 * here rather than shipping as "common.close" on a button.
 */
function Providers({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="pt-BR" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

export function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return rtlRender(ui, { wrapper: Providers, ...options });
}

/**
 * TS-27 / SPEC-016 BR-016-15. Runs axe over a container and returns the
 * results for `expect(...).toHaveNoViolations()`.
 *
 * Two rules are off, both deliberately:
 *
 * - `region` asserts all content sits inside a landmark. True of a page,
 *   meaningless for a primitive rendered on its own.
 * - `color-contrast` needs a canvas to sample painted pixels, and jsdom has no
 *   paint. Leaving it enabled would let it report "incomplete" and read as a
 *   pass. Contrast is checked for real by PR3's Playwright baselines (DL-16).
 *
 * Every other rule stays on.
 */
export async function audit(container: Element) {
  return axe(container, {
    rules: { region: { enabled: false }, 'color-contrast': { enabled: false } },
  });
}

export * from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
