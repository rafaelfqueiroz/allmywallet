import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/session';
import { exportUserData, exportUserDataAsCsv } from '@/core/privacy/export-user-data';
import { withPrivacyDeps } from '@/app/(settings)/privacy/composition';

/** SPEC-004 BR-004-11 / AR-33 / SPEC-003 BR-003-13: same shape as the JSON route; `exportUserDataAsCsv` already neutralises formula-injection cells (`src/lib/csv.ts`). */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const userId = await requireUserId();
  const data = await withPrivacyDeps(userId, (deps) => exportUserData(deps, userId));
  if (data === null) {
    return NextResponse.json({ error: 'PROFILE_NOT_FOUND' }, { status: 404 });
  }

  const csv = exportUserDataAsCsv(data);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="allmywallet-export.csv"',
    },
  });
}
