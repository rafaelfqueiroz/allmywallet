import type { ReactNode } from 'react';
import { AuthenticatedFrame } from '@/app/authenticated-frame';

/**
 * Settings gets the same frame as the app: `/preferences` is one of the four
 * navigation destinations, and it is also where the theme is changed — so the
 * page that sets the preference has to be inside the frame that applies it.
 */
export default function SettingsGroupLayout({ children }: { children: ReactNode }) {
  return <AuthenticatedFrame>{children}</AuthenticatedFrame>;
}
