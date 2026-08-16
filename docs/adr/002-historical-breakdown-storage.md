# ADR-002 — Where a snapshot's per-dimension breakdown lives

**Status:** Accepted
**Date:** 2026-08-16

## Context

`daily_valuation_snapshots` holds one row per user per day: `total_value`,
`net_contributions`, `earnings_to_date`, and a `by_asset_class` jsonb map. That
is everything the table knows about *how* a total decomposes.

SPEC-011 offers five grouping dimensions — `asset_class`, `wallet`, `asset`,
`sector`, `institution` — and three reports then ask historical questions along
whichever one the user picked:

| | What it asks of history |
|---|---|
| SPEC-012 (#15) | a per-wallet **value series**, to compute a wallet's TWR and XIRR |
| SPEC-013 (#16) | BR-013-05's **stacked series** by the selected grouping |
| SPEC-014 (#17) | historical allocation, to attribute earnings to a wallet |

With only `by_asset_class` stored, all three refuse for four of the five
dimensions — `SCOPE_SERIES_UNAVAILABLE` and `NO_HISTORICAL_BREAKDOWN`. The
refusals are honest and were the right interim behaviour, but they are one
cause described in three places ([#50]).

The PRD settles the prior question this raises. FR-5.11 asks for the value
split "as a stacked series — so the user can watch, for example, the
fixed-income share grow relative to equities, **or one wallet grow relative to
another**", and the SPEC-010 acceptance narrative has Marina reading
"performance-vs-CDI for that wallet alone". Per-wallet *history* is a product
requirement, not an inference from the specs.

## The distinction that decides the shape

**Four of the five dimensions are properties of the asset or of the position.**
An asset's class, its identity, its sector and the institution that custodies it
are all knowable at any past date from the ledger, the position cache and the
asset catalog. A snapshot can therefore decompose its own total along those
dimensions and a rebuild will reproduce the same numbers — which is what keeps
the table a derived cache (BR-009-17) and keeps rebuild-equals-incremental
(DM-4) true.

**`wallet` is not.** An allocation is a user decision that changes over time,
and `wallet_allocations` stores only its current state. BR-013-05 asks what the
split was *on each historical day*, so applying today's allocation backwards
would silently rewrite every past chart the moment someone reassigns an asset —
and a rebuild would disagree with the snapshot it replaced, breaking DM-4.

So this is two problems wearing one coat, and they get separate answers.

## Options

1. **A separate `valuation_snapshot_breakdowns` table**, one row per
   `(user, date, dimension, key)`. Rejected: it multiplies rows by the
   cardinality of every dimension over every day of history, adds a second
   tenant-scoped table with its own RLS policy and isolation test, and puts a
   join on the exact read path SPEC-016 BR-016-05 budgets.
2. **Additional jsonb columns on `daily_valuation_snapshots`**, mirroring
   `by_asset_class`. Chosen for the four asset-derived dimensions.
3. **Store a `by_wallet` map the same way, computed from current allocations.**
   Rejected as the answer for wallet: it is not reconstructable, so it fails
   DM-4 and rewrites history on reassignment.
4. **Version the allocations** so the split at any past date is recoverable,
   then treat `wallet` like the other four. Chosen for wallet, deferred to its
   own change.

## Decision

**Four dimensions now, as jsonb columns.** `daily_valuation_snapshots` gains
`by_institution`, `by_asset` and `by_sector`, each `jsonb NOT NULL DEFAULT
'{}'::jsonb`, alongside the existing `by_asset_class`.

- One row per user per day survives, and that composite primary key is what
  makes the snapshot writer idempotent (AR-19).
- The widest dimension against the SPEC-016 reference workload is ~100 asset
  keys per row — a few KB — over ~1,825 rows per user.
- No new table means no new RLS surface, no new isolation test, and no join
  added to the report hot path.
- Additive-with-default is expand/contract-safe (AR-69, DV-27), which is not
  optional: production is the only environment ([BL-003]).
- **Existing rows are not backfilled.** They read `{}`. A snapshot is a derived
  cache and BR-009-18's forward invalidation already rebuilds it; a bespoke
  data migration would be a second way to populate the same column, and the two
  would eventually disagree.

**`wallet` keeps refusing, for a narrower and better-stated reason.**
`NO_HISTORICAL_BREAKDOWN` now names one dimension instead of four, and says
what is actually missing: allocation is not versioned. Retiring it needs an
effective-dated record of allocation changes, written by the same repository
paths that maintain `wallet_allocations` today, so that the split as it stood on
any past date is reconstructable and a rebuild reproduces it exactly. That is a
separate change with its own migration and isolation test.

## Consequences

- SPEC-013's stacked series answers `asset_class`, `institution`, `asset` and
  `sector`; `wallet` returns the typed unavailable result.
- `sector` is present but every key is "Not classified" until the asset catalog
  grows a sector column — sourcing that data is PRD open question Q5 and is
  listed Out of Scope on SPEC-015. The dimension is wired end to end and the
  data is honestly absent, which is different from the dimension not existing.
- SPEC-012's wallet-scoped TWR and XIRR keep returning
  `SCOPE_SERIES_UNAVAILABLE` until allocation history lands.
- The nightly performance budget must be re-measured: row width grows, and this
  is the table every report scans.

[#50]: https://github.com/rafaelfqueiroz/allmywallet/issues/50
[BL-003]: https://github.com/rafaelfqueiroz/allmywallet/issues/3
