# AllMyWallet

A web app for Brazilian retail investors to consolidate every investment — stocks, FIIs, BDRs, ETFs, Tesouro Direto, CDB, LCI and LCA — into one place, group holdings into purpose-driven wallets, and get honest answers about performance, portfolio value, earnings and composition — each viewable grouped by asset type, by wallet, or by individual asset.

**Status:** pre-implementation. The product specification is complete; no code has been written yet.

## Start here

📄 **[docs/PRD.md](docs/PRD.md)** — the full product requirements document.
📁 **[docs/specs/](docs/specs/README.md)** — 16 specifications decomposing the PRD into implementable units.

## The short version

**The problem.** Investments live in different systems that speak different languages. No single place answers *"how is my money actually doing, and is it beating the CDI?"* — and no broker models the fact that money has purposes.

**The approach.** One ledger, many views. Transactions are the single source of truth; positions, valuations and every report figure derive from them and can always be rebuilt. Wallets are purpose-based groupings that cut across brokers and asset classes, so the retirement money can be measured separately from everything else.

**One constraint worth knowing up front.** B3's Área do Investidor APIs are B2B-only — individuals cannot get credentials. So v1 gets custody data from the `.xlsx` extracts the user exports from investidor.b3.com.br, while market data (quotes, Tesouro prices, CDI/IPCA/IBOV) syncs automatically every day. The reasoning, the alternatives weighed, and the path to true auto-sync are in [§4 of the PRD](docs/PRD.md#4-data-sourcing-strategy).

## Planned stack

Next.js · TypeScript · PostgreSQL (with row-level security for tenant isolation) · Google OAuth

## Scope at a glance

| In v1 | Deferred |
|---|---|
| Stocks, FIIs, BDRs, ETFs | Investment funds (fundos) |
| Tesouro Direto | Options and derivatives |
| CDB, LCI, LCA | Crypto |
| Wallets, 4 report families | Foreign brokerage |
| Google login, LGPD program | IR / tax report generation |
