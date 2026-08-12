import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'AllMyWallet',
  description: 'Seus investimentos, em um só lugar',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    // SPEC-016 BR-016-15: `lang` is the first accessibility requirement — a
    // screen reader reading pt-BR content with an en-US voice is unusable.
    <html lang={locale}>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
