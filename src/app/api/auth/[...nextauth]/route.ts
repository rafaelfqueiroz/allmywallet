import { NextResponse, type NextRequest } from 'next/server';
import { handlers } from '@/auth';
import { authRateLimiter } from '@/lib/rate-limit';
import { logSecurityEvent } from '@/lib/security-events';

/**
 * AR-33: a route handler because Auth.js's callback protocol (redirects,
 * provider callbacks, CSRF cookies) is not expressible as a server action.
 *
 * SPEC-001 BR-001-11: every `/api/auth/*` request is rate-limited per IP
 * before it reaches Auth.js's own handler — `src/lib/rate-limit.ts` has the
 * single-instance caveat.
 */
function clientIp(request: NextRequest): string {
  // Caddy (ARCHITECTURE §1) sets X-Forwarded-For; the leftmost entry is the
  // original client. Falls back to a constant key so a missing header
  // degrades to "rate-limit everyone together" rather than "rate-limit no
  // one" — the safer failure direction for a security control.
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : 'unknown';
}

async function rateLimited(request: NextRequest): Promise<NextResponse | null> {
  const ip = clientIp(request);
  if (authRateLimiter.tryConsume(ip)) return null;

  logSecurityEvent({
    type: 'auth_rate_limit_exceeded',
    route: request.nextUrl.pathname,
  });
  return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
}

export async function GET(request: NextRequest): Promise<Response> {
  const limited = await rateLimited(request);
  if (limited) return limited;
  return handlers.GET(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  const limited = await rateLimited(request);
  if (limited) return limited;
  return handlers.POST(request);
}
