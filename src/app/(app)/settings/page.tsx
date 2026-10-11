import { redirect } from 'next/navigation';

/**
 * SPEC-022 BR-022-05 — Configurações has no page of its own, only sections.
 * Its first, Carteiras, is where the destination opens: the sidebar's item
 * points at `/settings` so it stays current across every section.
 */
export default function SettingsPage(): never {
  redirect('/settings/wallets');
}
