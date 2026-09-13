'use server';

import { redirect } from 'next/navigation';
import { requireUserId } from '@/lib/session';
import { dismissOnboardingFor, reopenOnboardingFor } from '@/app/(app)/onboarding/data';

/**
 * SPEC-020 BR-020-11..13 — dismiss and reopen the guide. AR-12: identity comes
 * from `requireUserId()`, never from a form field. Both are plain `<form
 * action={...}>` submissions (POST) rather than `Link`s: BR-020-12 makes
 * dismissal a real state change (`users.onboarding_dismissed_at`), and BR-020-13
 * makes reopening one too (clearing it) — a GET request must never cause
 * either, which is why the help entry point (`AppShell`) posts to
 * `reopenOnboardingAction` instead of merely navigating to `/onboarding`.
 */

export async function dismissOnboardingAction(_formData: FormData): Promise<void> {
  const userId = await requireUserId();
  await dismissOnboardingFor(userId);
  redirect('/dashboard');
}

export async function reopenOnboardingAction(_formData: FormData): Promise<void> {
  const userId = await requireUserId();
  await reopenOnboardingFor(userId);
  redirect('/onboarding');
}
