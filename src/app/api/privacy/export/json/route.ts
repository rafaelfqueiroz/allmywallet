import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/session';
import { exportUserData, exportUserDataAsJson } from '@/core/privacy/export-user-data';
import { withPrivacyDeps } from '@/app/(settings)/privacy/composition';

/**
 * SPEC-004 BR-004-11 — AR-33: a route handler, not a server action, because
 * this delivers a downloadable file with its own `Content-Disposition`, not
 * a form result. See `export-user-data.ts`'s doc comment for why this is
 * synchronous rather than a queued, signed-URL download (the plan's stated
 * shape) — no object-storage adapter exists yet.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const userId = await requireUserId();
  const data = await withPrivacyDeps(userId, (deps) => exportUserData(deps, userId));
  if (data === null) {
    return NextResponse.json({ error: 'PROFILE_NOT_FOUND' }, { status: 404 });
  }

  const json = exportUserDataAsJson(data);
  return new NextResponse(json, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="allmywallet-export.json"',
    },
  });
}
