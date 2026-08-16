import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import '@/app/globals.css';
import { ThemeScript } from '@/components/patterns/theme';

export const metadata: Metadata = {
  title: 'AllMyWallet',
  description: 'Seus investimentos, em um só lugar',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  /*
   * Deliberately no session or config read here. `tryUserId()` reads cookies,
   * and a cookie read in the *root* layout opts every route into dynamic
   * rendering — it turned `/` and `/signin` from prerendered into
   * server-rendered on demand, which matters most for the one page whose job
   * is to be fast and indexable (#37). The per-account theme is therefore
   * reconciled in the authenticated route groups instead; see
   * src/app/authenticated-frame.tsx.
   */
  return (
    // SPEC-016 BR-016-15: `lang` is the first accessibility requirement — a
    // screen reader reading pt-BR content with an en-US voice is unusable.
    // `suppressHydrationWarning` covers exactly one attribute: ThemeScript
    // stamps a class on <html> before React hydrates, so the server markup and
    // the live DOM legitimately differ there and nowhere else.
    <html lang={locale} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
