'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';

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

/**
 * Applies a theme now and remembers it for this device's next pre-paint guess
 * (`ThemeScript`).
 */
function rememberTheme(theme: ThemePreference) {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable. The class is already applied for this page; the
    // next navigation re-applies it from the server value anyway.
  }
}

/** Reconciles the pre-paint guess with the account's stored preference. */
export function ThemeSync({ theme }: { theme: ThemePreference }) {
  useEffect(() => {
    rememberTheme(theme);
  }, [theme]);

  return null;
}

/**
 * SPEC-022 BR-022-30 — choosing a theme from the account menu.
 *
 * The class changes on the click, before the server has answered, so the
 * switch applies **without a reload**; `save` then persists `ui.theme` to the
 * account (DS-29), which is what makes the choice survive a new session. A
 * refused save puts back **the theme the account holds** rather than leaving
 * the screen showing a choice it does not.
 *
 * "The theme the account holds" is the last *confirmed* one, never the
 * previous selection: with Sistema stored, choosing Escuro and then Claro
 * before either save answers makes Escuro the previous selection, and a
 * rollback to it would show a theme that was never saved. Only the newest
 * choice may change the screen when its save answers; an older save that
 * succeeds updates what the account holds and nothing else.
 *
 * The state lives in the caller (the account menu), not in the menu content:
 * Radix unmounts the content when the menu closes, and reopening it before the
 * server's revalidated value arrives would otherwise show the old choice.
 */
export function useThemeChoice(
  stored: ThemePreference,
  save: (theme: ThemePreference) => Promise<{ readonly status: 'saved' | 'error' }>,
): readonly [ThemePreference, (next: ThemePreference) => void] {
  const [current, setCurrent] = useState(stored);
  const [, startTransition] = useTransition();
  /** What the account holds: the server's value, or the newest save it accepted. */
  const confirmed = useRef(stored);
  const confirmedChoice = useRef(0);
  const latestChoice = useRef(0);

  // A newer server value (another tab, Preferências) wins over a stale local one.
  useEffect(() => {
    confirmed.current = stored;
    setCurrent(stored);
  }, [stored]);

  function choose(next: ThemePreference) {
    if (next === current) return;
    const choice = ++latestChoice.current;
    setCurrent(next);
    rememberTheme(next);
    startTransition(async () => {
      // A save that *throws* — the session ended in another tab, the database
      // is down — is a refusal too. Left uncaught, React would hand it to the
      // nearest error boundary and replace the page over a theme.
      let saved = false;
      try {
        saved = (await save(next)).status === 'saved';
      } catch {
        saved = false;
      }
      // Server actions answer in the order they were sent, so the newest
      // accepted save is what the account holds.
      if (saved && choice > confirmedChoice.current) {
        confirmed.current = next;
        confirmedChoice.current = choice;
      }
      // A newer choice owns the screen; this answer is only bookkeeping.
      if (choice !== latestChoice.current) return;
      if (!saved) {
        setCurrent(confirmed.current);
        rememberTheme(confirmed.current);
      }
    });
  }

  return [current, choose] as const;
}

const THEME_OPTIONS: readonly { value: ThemePreference; icon: LucideIcon }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
];

/**
 * Claro · Escuro · Sistema as a segmented control inside the account menu
 * (BR-022-30, the approved prototype). They are `menuitemradio` items, so the
 * menu's own arrow-key navigation reaches them and a screen reader announces
 * which one is checked. Choosing one keeps the menu open, so the person sees
 * the result and can change their mind without reopening it.
 */
export function ThemeMenuGroup({
  value,
  onValueChange,
}: {
  value: ThemePreference;
  onValueChange: (theme: ThemePreference) => void;
}) {
  const t = useTranslations('accountMenu.theme');

  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={(next) => onValueChange(next as ThemePreference)}
      aria-label={t('label')}
      className="flex gap-1 rounded-lg bg-muted p-1"
    >
      {THEME_OPTIONS.map(({ value: option, icon: Icon }) => (
        <DropdownMenuRadioItem
          key={option}
          value={option}
          indicator={false}
          onSelect={(event) => event.preventDefault()}
          // The highlighted item's `accent` fill barely differs from the
          // group's `muted` track, so keyboard focus is a ring (DS-48, WCAG 2.4.7).
          className="flex-1 justify-center focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=checked]:bg-card data-[state=checked]:font-medium data-[state=checked]:shadow-sm"
        >
          <Icon aria-hidden="true" />
          {t(option)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
