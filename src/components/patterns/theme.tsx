'use client';

import { useEffect } from 'react';

export const THEME_STORAGE_KEY = 'amw-theme';

export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * DL-03's three states are decided in two places, for one reason: the class
 * has to be on <html> *before first paint*, and the persisted value lives in
 * the database.
 *
 * `ThemeScript` runs synchronously in <head> and applies whatever this device
 * last saw, so nobody watches a white page repaint to dark. `ThemeSync` runs
 * after hydration and reconciles that guess with the account's real
 * preference, which is what makes the setting follow the user to a new device.
 *
 * 'system' deliberately stamps *no* class — globals.css falls through to
 * prefers-color-scheme, so the OS keeps control including when it changes
 * mid-session.
 */
function applyTheme(theme: ThemePreference) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme !== 'system') root.classList.add(theme);
}

/**
 * Inline, blocking, and deliberately not a React effect — an effect runs after
 * paint, which is exactly the flash this exists to prevent. Wrapped in
 * try/catch because localStorage throws outright in some privacy modes, and a
 * theme preference is never worth a blank page.
 */
export function ThemeScript() {
  const script = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
    THEME_STORAGE_KEY,
  )});if(t==='light'||t==='dark'){document.documentElement.classList.add(t)}}catch(e){}})()`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

/** Reconciles the pre-paint guess with the account's stored preference. */
export function ThemeSync({ theme }: { theme: ThemePreference }) {
  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage unavailable. The class is already applied for this page; the
      // next navigation re-applies it from the server value anyway.
    }
  }, [theme]);

  return null;
}
