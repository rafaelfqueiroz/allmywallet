/**
 * SPEC-004 BR-004-07: every consent decision records "the policy version in
 * force at that moment." One constant, imported by both the policy page
 * (`src/app/privacy-policy/page.tsx`, which displays it) and the consent
 * actions (`src/app/(settings)/privacy/actions.ts`, which stamps it onto
 * every grant/revoke) — so the two can never silently disagree about which
 * version is "current." Bump this string whenever the policy text changes in
 * a way a consent decision should be able to point back to.
 */
export const CURRENT_PRIVACY_POLICY_VERSION = '2026-01-01';
