/**
 * SPEC-008 BR-008-07: the calendar's *hours* are data, never hardcoded in
 * polling logic. This file is that data — a small, generated (not scraped)
 * B3 holiday list and the regular/half session hours, all in `America/Sao_Paulo`
 * local time. Out of this spec's scope is sourcing a complete authoritative
 * B3 holiday feed; this is a representative dataset sufficient to prove the
 * calendar mechanism and to drive deterministic tests (TS-26 — no test
 * depends on a live provider, and a calendar dataset is not one).
 *
 * Extend this list as real years are needed — it is intentionally not a
 * formula (Brazilian holidays include moveable feasts) and never will be.
 */

/** B3 full-day holidays — regular session does not open at all. `YYYY-MM-DD`. */
export const B3_HOLIDAYS: readonly string[] = [
  // 2026
  '2026-01-01', // Confraternização Universal
  '2026-02-16', // Carnaval (Monday)
  '2026-02-17', // Carnaval (Tuesday)
  '2026-04-03', // Sexta-feira Santa
  '2026-04-21', // Tiradentes
  '2026-05-01', // Dia do Trabalho
  '2026-06-04', // Corpus Christi
  '2026-09-07', // Independência do Brasil
  '2026-10-12', // Nossa Senhora Aparecida
  '2026-11-02', // Finados
  '2026-11-15', // Proclamação da República
  '2026-11-20', // Consciência Negra (B3 calendar since 2024)
  '2026-12-25', // Natal
];

/** B3 half-sessions — trades, but the regular session ends early. `YYYY-MM-DD`. */
export const B3_HALF_SESSIONS: readonly string[] = [
  '2026-12-24', // Véspera de Natal
  '2026-12-31', // Véspera de Ano Novo
];

/** Regular B3 equities session, local time — matches SPEC-008's "~7h session" reference. */
export const REGULAR_SESSION = { openHour: 10, openMinute: 0, closeHour: 17, closeMinute: 0 };

/** Half-session close — the session still opens at the regular time. */
export const HALF_SESSION_CLOSE = { closeHour: 13, closeMinute: 0 };
