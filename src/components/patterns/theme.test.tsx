import { afterEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY, ThemeScript, ThemeSync } from '@/components/patterns/theme';
import { render, waitFor } from '@/components/test-utils';

afterEach(() => {
  document.documentElement.classList.remove('light', 'dark');
  window.localStorage.clear();
});

describe('ThemeScript', () => {
  /*
   * This runs before React exists, so it is asserted as source rather than
   * behaviour. What matters is that it stays synchronous and self-contained:
   * turning it into an effect would reintroduce the white-to-dark flash it
   * exists to prevent, and the test would not notice.
   */
  it('emits a synchronous inline script keyed to the same storage key', () => {
    const { container } = render(<ThemeScript />);
    const script = container.querySelector('script');

    expect(script).toBeInTheDocument();
    expect(script?.innerHTML).toContain(THEME_STORAGE_KEY);
    expect(script?.hasAttribute('defer')).toBe(false);
    expect(script?.hasAttribute('async')).toBe(false);
  });

  it('applies only an explicit choice, never a class for "system"', () => {
    const { container } = render(<ThemeScript />);
    const source = container.querySelector('script')?.innerHTML ?? '';

    expect(source).toContain("t==='light'||t==='dark'");
    expect(source).not.toContain("'system'");
  });

  it('swallows storage errors — a theme is never worth a blank page', () => {
    const { container } = render(<ThemeScript />);
    expect(container.querySelector('script')?.innerHTML).toContain('catch');
  });
});

describe('ThemeSync', () => {
  it('stamps the explicit choice on the document root', async () => {
    render(<ThemeSync theme="dark" />);
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
  });

  /*
   * DL-03's third state. 'system' must stamp *nothing* — globals.css then falls
   * through to prefers-color-scheme, which keeps working when the OS switches
   * mid-session. Stamping 'light' here would silently freeze the user out of
   * their own OS setting.
   */
  it('stamps no class for the system preference', async () => {
    render(<ThemeSync theme="system" />);
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system'));

    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('light');
  });

  it('replaces a previous choice rather than accumulating classes', async () => {
    const { rerender } = render(<ThemeSync theme="dark" />);
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));

    rerender(<ThemeSync theme="light" />);

    await waitFor(() => expect(document.documentElement).toHaveClass('light'));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  // The pre-paint script reads this on the next load; without it the account
  // preference would flash on every navigation.
  it('mirrors the account preference into storage for the pre-paint script', async () => {
    render(<ThemeSync theme="dark" />);
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark'));
  });
});
