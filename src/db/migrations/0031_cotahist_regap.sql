-- SPEC-008 BR-008-30 / SPEC-021 BR-021-31 (#171): every `not_supplied` gap
-- recorded so far was brapi's answer — its history had no close for the day.
-- Closes now come from B3's COTAHIST, whose answer brapi's does not stand in
-- for (DL-008-14), so each of those days is asked again, once.
--
-- Relabelled `provider_unavailable`, the reason the close job revisits on every
-- run (`syncOfficialCloses`). Where COTAHIST has the close it is written and
-- the gap cleared; where it has none, the gap is recorded `not_supplied` again,
-- now as COTAHIST's own answer, and never asked for again.
--
-- Listed assets only: a Tesouro gap is Tesouro Transparente's answer, which
-- still stands. Data only, no DDL (AR-69): a rolled-back image reads the same
-- reasons it always has, and shows the same days as gaps.
UPDATE price_quote_gaps g
   SET reason = 'provider_unavailable',
       updated_at = now()
  FROM assets a
 WHERE a.id = g.asset_id
   AND a.class IN ('stock', 'fii', 'bdr', 'etf')
   AND g.reason = 'not_supplied';
