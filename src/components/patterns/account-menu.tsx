'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  CircleHelp,
  LogOut,
  Shield,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeMenuGroup, useThemeChoice, type ThemePreference } from '@/components/patterns/theme';

/** What Google supplied (SPEC-001 BR-001-05), and nothing else. */
export interface AccountMenuProfile {
  readonly name: string | null;
  readonly email: string;
  readonly imageUrl: string | null;
}

type FormAction = (formData: FormData) => Promise<void>;

export interface AccountMenuProps {
  readonly profile: AccountMenuProfile;
  readonly theme: ThemePreference;
  readonly saveTheme: (theme: ThemePreference) => Promise<{ readonly status: 'saved' | 'error' }>;
  readonly signOutAction: FormAction;
  readonly helpAction: FormAction;
}

/**
 * SPEC-022 BR-022-09/10/11 — the account menu in the top bar: the person's
 * Google name, e-mail and picture, then everything that belongs to the person
 * rather than to a feature — Conta, Preferências, Privacidade, the onboarding
 * guide (SPEC-020 BR-020-13), the theme switch (BR-022-30) and Sair.
 *
 * Built on the vendored Radix `DropdownMenu`, which is what makes it fully
 * keyboard-operable: Enter/Space/ArrowDown open it, arrows move through every
 * item including the theme options, Escape closes it and returns focus to the
 * trigger (DS-20).
 *
 * **Two items are state changes, so they are form submissions, never links**
 * (BR-022-11, BR-020-13): Sair deletes the server-side session and the guide
 * entry clears `onboarding_dismissed_at`. A GET — a prefetch, a crawler — must
 * cause neither. The forms sit *outside* the menu content and the items submit
 * them through the `form` attribute: Radix unmounts the content as soon as an
 * item is chosen, and the submission must not depend on a form that is being
 * torn down.
 *
 * Every action is a prop rather than an import (DS-02): this pattern knows
 * nothing about Auth.js, the registry or onboarding. `authenticated-frame.tsx`
 * wires the real ones in.
 */
export function AccountMenu({
  profile,
  theme,
  saveTheme,
  signOutAction,
  helpAction,
}: AccountMenuProps) {
  const t = useTranslations('accountMenu');
  const tNav = useTranslations('nav');
  const [themeChoice, chooseTheme] = useThemeChoice(theme, saveTheme);
  const signOutFormId = useId();
  const helpFormId = useId();
  const displayName = profile.name ?? profile.email;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-9 gap-2 rounded-full pr-2 pl-1">
            <Avatar profile={profile} size="sm" />
            {/* WCAG 2.5.3: the accessible name contains the visible name. */}
            <span className="sr-only">{t('trigger')}, </span>
            <span className="hidden max-w-40 truncate sm:inline">{displayName}</span>
            <span className="sr-only sm:hidden">{displayName}</span>
            <ChevronDown aria-hidden="true" className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-72 p-2">
          <DropdownMenuLabel className="flex items-center gap-3 px-2 py-2 text-sm font-normal text-foreground">
            <Avatar profile={profile} size="lg" />
            <span className="flex min-w-0 flex-col">
              {profile.name && <span className="truncate font-medium">{profile.name}</span>}
              <span className="truncate text-xs text-muted-foreground">{profile.email}</span>
            </span>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link href="/account">
                <UserRound aria-hidden="true" />
                {t('account')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/preferences">
                <SlidersHorizontal aria-hidden="true" />
                {t('preferences')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/privacy">
                <Shield aria-hidden="true" />
                {t('privacy')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <button type="submit" form={helpFormId} className="w-full">
                <CircleHelp aria-hidden="true" />
                {tNav('help')}
              </button>
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          <DropdownMenuLabel>{t('theme.label')}</DropdownMenuLabel>
          <ThemeMenuGroup value={themeChoice} onValueChange={chooseTheme} />

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild>
            <button type="submit" form={signOutFormId} className="w-full">
              <LogOut aria-hidden="true" />
              {t('signOut')}
            </button>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <form id={helpFormId} action={helpAction} hidden />
      <form id={signOutFormId} action={signOutAction} hidden />
    </>
  );
}

/**
 * The Google picture, or the initials when there is none or it fails to load.
 * Decorative (`alt=""`): the name beside it already says whose it is.
 * `no-referrer` because Google's image host refuses some hot-linked requests
 * that carry one.
 */
function Avatar({ profile, size }: { profile: AccountMenuProfile; size: 'sm' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  const box = size === 'sm' ? 'size-7 text-xs' : 'size-10 text-sm';

  if (profile.imageUrl && !failed) {
    return (
      <img
        src={profile.imageUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        data-slot="account-avatar"
        className={cn('shrink-0 rounded-full object-cover', box)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      data-slot="account-avatar"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-primary font-medium text-primary-foreground',
        box,
      )}
    >
      {initials(profile.name ?? profile.email)}
    </span>
  );
}

function initials(source: string): string {
  // An e-mail stands in only when Google sent no name; its domain is not a name.
  const words = (source.split('@')[0] ?? '').split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  return letters
    .map((word) => word?.charAt(0) ?? '')
    .join('')
    .toLocaleUpperCase('pt-BR');
}
