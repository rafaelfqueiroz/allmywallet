# AllMyWallet

A web app for Brazilian retail investors to consolidate every investment — stocks, FIIs, BDRs, ETFs, Tesouro Direto, CDB, LCI and LCA — into one place, group holdings into purpose-driven wallets, and get honest answers about performance, portfolio value, earnings and composition — each viewable grouped by asset type, by wallet, or by individual asset.

**Status:** pre-implementation. The product specification is complete; no code has been written yet.

## Where things live

| | | |
|---|---|---|
| 📄 | **[PRD](https://github.com/rafaelfqueiroz/allmywallet/wiki/PRD)** | Product requirements — wiki |
| 📁 | **[Specs](https://github.com/rafaelfqueiroz/allmywallet/wiki/Specs)** | 16 specifications decomposing the PRD — wiki |
| 🛠 | **[Guidelines](docs/guidelines/README.md)** | Architecture, development, testing — this repo, next to the code they govern |
| 📋 | **[Board](https://github.com/users/rafaelfqueiroz/projects/3/views/1)** | All work: one task per spec, plus deferred items |

**Product documents are edited in the wiki**, not here — it is their source of truth. Engineering guidelines are edited here and reviewed in PRs. Tasks live on the board and each one links to its spec page.

## The short version

**The problem.** Investments live in different systems that speak different languages. No single place answers *"how is my money actually doing, and is it beating the CDI?"* — and no broker models the fact that money has purposes.

**The approach.** One ledger, many views. Transactions are the single source of truth; positions, valuations and every report figure derive from them and can always be rebuilt. Wallets are purpose-based groupings that cut across brokers and asset classes, so the retirement money can be measured separately from everything else.

**One constraint worth knowing up front.** B3's Área do Investidor APIs are B2B-only — individuals cannot get credentials. So v1 gets custody data from the `.xlsx` extracts the user exports from investidor.b3.com.br, while market data (quotes, Tesouro prices, CDI/IPCA/IBOV) syncs automatically every day. The reasoning, the alternatives weighed, and the path to true auto-sync are in [§4 of the PRD](https://github.com/rafaelfqueiroz/allmywallet/wiki/PRD#4-data-sourcing-strategy).

## Stack

Next.js (App Router) · TypeScript · PostgreSQL with row-level security · Drizzle · decimal.js · Auth.js (Google) · pg-boss · Tailwind + shadcn/ui · Vitest + Playwright · Docker Compose on a São Paulo VPS.

Full rationale in the [guidelines](docs/guidelines/README.md).

## Scope at a glance

| In v1 | Deferred |
|---|---|
| Stocks, FIIs, BDRs, ETFs | Investment funds (fundos) |
| Tesouro Direto | Options and derivatives |
| CDB, LCI, LCA | Crypto |
| Wallets, 4 report families | Foreign brokerage |
| Google login, LGPD program | IR / tax report generation |
