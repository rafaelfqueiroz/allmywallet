'use client';

import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PARAM } from '@/lib/report-url-state';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * SPEC-022 BR-022-17 / DL-022-09 — the one scope selector, in the page header
 * of Portfólio and Relatórios: all wallets, or a single wallet (BR-011-02).
 *
 * **The scope is the URL.** Choosing writes the `wallet` parameter — the
 * existing name, `PARAM.wallet`, holding the wallet id — and "all" removes it,
 * so a view can be bookmarked and a tab switch can carry it
 * (`RouteTabs.preserveParams`, BR-011-11). Every other parameter in the URL is
 * kept: the period, the grouping and a table's page are not this control's to
 * erase.
 *
 * **The items are `menuitemradio`s**, not links. A radio group says what a user
 * needs to hear — one choice among several, this one checked — and a menu of
 * links can only say "current page". The cost is the anchor's extras (open in a
 * new tab, a visible destination), which a scope choice does not need: it is a
 * setting of this view, not a place to go. Selecting `push`es a history entry,
 * because a changed scope is a different view the Back button should be able to
 * undo.
 *
 * A `wallet` id the list does not contain (a wallet deleted since the link was
 * made) checks nothing and labels the trigger "all": the page itself says the
 * wallet is gone (`reports.scope.walletNotFound`), and this control must not
 * invent a name for it.
 *
 * Rendered nowhere yet: destinations adopt it as their issues land.
 */
export type ScopeWallet = { readonly walletId: string; readonly name: string };

export type ScopeSelectorProps = {
  readonly wallets: readonly ScopeWallet[];
  readonly className?: string;
};

const ALL = 'all';

export function ScopeSelector(props: ScopeSelectorProps) {
  // `useSearchParams` needs a Suspense boundary for a statically rendered page;
  // see `RouteTabs` for the same reasoning.
  return (
    <Suspense fallback={<Selector {...props} params={new URLSearchParams()} />}>
      <ConnectedSelector {...props} />
    </Suspense>
  );
}

function ConnectedSelector(props: ScopeSelectorProps) {
  return <Selector {...props} params={useSearchParams()} />;
}

function Selector({
  wallets,
  className,
  params,
}: ScopeSelectorProps & { readonly params: URLSearchParams | ReadonlyURLParams }) {
  const t = useTranslations('scopeSelector');
  const pathname = usePathname();
  const router = useRouter();

  const requested = params.get(PARAM.wallet);
  const selected = wallets.find((wallet) => wallet.walletId === requested);
  const value = selected?.walletId ?? ALL;

  /** The current URL with the scope replaced and everything else kept. */
  const hrefFor = (walletId: string): string => {
    const next = new URLSearchParams(params.toString());
    if (walletId === ALL) next.delete(PARAM.wallet);
    else next.set(PARAM.wallet, walletId);
    const query = next.toString();
    return query === '' ? pathname : `${pathname}?${query}`;
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          data-slot="scope-selector"
          className={cn('max-w-full justify-between', className)}
        >
          <span className="text-muted-foreground">{t('label')}</span>{' '}
          <span className="truncate font-medium">{selected?.name ?? t('allWallets')}</span>
          <ChevronDown aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => router.push(hrefFor(next))}>
          <DropdownMenuRadioItem value={ALL}>{t('allWallets')}</DropdownMenuRadioItem>
          {wallets.length > 0 && <DropdownMenuSeparator />}
          {wallets.map((wallet) => (
            <DropdownMenuRadioItem key={wallet.walletId} value={wallet.walletId}>
              {wallet.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What `useSearchParams` returns: read-only, but it can be stringified. */
type ReadonlyURLParams = { get(name: string): string | null; toString(): string };
