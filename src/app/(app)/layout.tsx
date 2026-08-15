import type { ReactNode } from 'react';
import { AuthenticatedFrame } from '@/app/authenticated-frame';

export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return <AuthenticatedFrame>{children}</AuthenticatedFrame>;
}
