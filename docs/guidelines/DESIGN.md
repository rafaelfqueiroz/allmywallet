# Design System

How the interface is built. The prose companion to [`src/app/globals.css`](../../src/app/globals.css) and [`src/components/`](../../src/components/).

Rules are numbered `DS-nn` and are citable from code and PRs the same way `AR-`, `DV-` and `TS-` rules are. The scoping decisions behind them are recorded as `DL-nn` in the Decision log of [#33](https://github.com/rafaelfqueiroz/allmywallet/issues/33); where this document explains *what the rule is*, the Decision log explains *why that option was chosen over the others*.

> **Status.** Complete. All three PRs under [#33](https://github.com/rafaelfqueiroz/allmywallet/issues/33) have landed: tokens and primitives, layout/patterns/shell/charts, and the retrofit with its enforcement. Every rule below describes code that exists.
>
> **M10 amendments** ([SPEC-022](https://github.com/rafaelfqueiroz/allmywallet/wiki/SPEC-022-Interface-Design-Navigation), [#201](https://github.com/rafaelfqueiroz/allmywallet/issues/201)). [#203](https://github.com/rafaelfqueiroz/allmywallet/issues/203) replaced the palette with the one approved with the M10 prototype (SPEC-022 DL-022-13): §2–§4 below. The wiki's [Approved tokens](https://github.com/rafaelfqueiroz/allmywallet/wiki/SPEC-022-Interface-Design-Navigation#approved-tokens) table records what was approved; this document and `globals.css` hold the living values. [#204](https://github.com/rafaelfqueiroz/allmywallet/issues/204) added the components the new page structure needs — §7, §8 and §10, DS-50 to DS-56. [#210](https://github.com/rafaelfqueiroz/allmywallet/issues/210) added the layout and field patterns Configurações › Carteiras needs — DS-60 to DS-64. [#237](https://github.com/rafaelfqueiroz/allmywallet/issues/237) set the table standard — column kinds, fixed widths, truncation with the full text on demand, 10/25/50 pages — DS-67. [#238](https://github.com/rafaelfqueiroz/allmywallet/issues/238) set the form layout — one panel, two columns, Cancelar then the primary action at the bottom right — DS-68.

## 1. What this is, and what it is not

Five layers. The design system owns the first four. The fifth belongs to the specs.

| Layer | Where | Owns |
|---|---|---|
| Tokens | `src/app/globals.css` | Named values — colour, radius, density. No opinion about usage |
| Primitives | `src/components/ui/` | Button, Input, Select, NativeSelect, Label, Table, Card, Badge, Dialog, Popover, DropdownMenu, Tabs, Skeleton |
| Layout | `src/components/layout/` | Stack, Grid, Cluster — the only sanctioned way a page expresses spacing |
| Patterns | `src/components/patterns/` | PageShell, PageHeader, AppShell, AccountMenu, RouteTabs, ScopeSelector, EmptyState, ErrorState, DataTable, StatCard, Money, Field, InfoTip, FileUpload, theme |
| Charts | `src/components/charts/` | The palette binding, ChartContainer, ChartLegend and the shared axis/tooltip props |
| **Pages** | `src/app/` | Screen composition. **Not part of the design system** |

**DS-01 — The test for whether something belongs in the system is whether a second, unrelated screen would need the exact same thing.** A focus ring: yes. A donut chart above a filtered position table: no — that is one report's answer to one spec, and it lives in `src/app/`.

**DS-02 — A primitive knows nothing about the domain.** `Button` has never heard of a wallet. The exception is deliberate and narrow: `Money` is a domain primitive, because AR-09's round-once-at-display rule needs exactly one home.

**DS-03 — Marketing is not the design system.** The landing page ([#37](https://github.com/rafaelfqueiroz/allmywallet/issues/37)) consumes tokens and primitives but its sections live in `src/components/marketing/`. Hero blocks are not reused by anything.

## 2. Tokens

**DS-04 — A component never hardcodes a colour, a radius or a raw pixel.** Every value comes from a token. Tailwind v4 reads them from `@theme`, so a token is also a utility: `--color-positive` gives `text-positive`, `--spacing-row` gives `py-row`.

The vocabulary is shadcn's, adopted wholesale rather than renamed (DL-02), plus the project additions marked below.

| Token | Means |
|---|---|
| `background` / `foreground` | The page and its text. Near-neutral graphite: a trace of the brand hue in the chroma, never a tint you can name |
| `card` / `popover` (+ `-foreground`) | The card layer and the raised layer (menus, dialogs). Distinct lightness steps in dark — see DS-46 |
| `primary` (+ `-foreground`) | The brand: a **navy** (SPEC-022 DL-022-05). Actions, navigation state, focus. Never a figure — DS-45. *DL-08 resolved by #202.* |
| `primary-hover` | **M10.** The primary button's hover. A token rather than `primary/80`, because a translucent navy over graphite drifts toward grey and loses contrast |
| `nav-active` (+ `-foreground`) | **M10.** The active navigation item's fill and text. A different token from `ring` — DS-48 |
| `secondary`, `muted`, `accent` (+ `-foreground`) | Recessive surfaces. `secondary` aliases `muted`; `accent` is the hover surface |
| `destructive` (+ `-foreground`) | A dangerous **action** — delete, revoke |
| `border`, `input`, `ring` | Hairlines, field outlines, focus rings. `input` reaches 3:1 against card and page (WCAG 1.4.11); `border` is a hairline between regions and is exempt |
| `chart-1` … `chart-8` | **Project addition.** Categorical series. See §4 |
| `positive`, `negative` | **Project addition.** A gain or a loss — a **figure**, not an action |
| `success`, `progress`, `warning`, `danger`, `neutral` (+ `-surface`) | **M10.** Status, for badges: the text colour on its own `-surface`. See DS-47 |
| `opportunity-buy` / `-hold` / `-sell` | **Project addition.** SPEC-018's watch-rule state (DL-018-06). Used only by `StateBadge` |
| `sidebar-*` | shadcn's sidebar vocabulary, aliased onto `primary`, `nav-active`, `border` and `ring` so the sidebar cannot grow a palette of its own |
| `--shadow-raised` | **M10.** The shadow of the raised layer — `Select`'s menu and `Dialog`. Used as `shadow-(--shadow-raised)` |
| `--radius` / `--radius-*` | **Two radii carry the interface** (SPEC-022 BR-022-36): a panel is `rounded-lg`, 8px (`--radius: 0.5rem`); a control — field, button, menu — is `rounded-md`, 6px. `rounded-sm`, 4px, is an item inside a menu or a tab list; `rounded-full` a pill. The steps are pinned rather than multiplied from `--radius`, because no single multiplier yields both 8 and 6. Nothing above `lg` — `tests/structural/panel-radius.test.ts` |

**An alias is declared once.** A token whose value is `var(--other)` — `ring`, `secondary`, every surface's `-foreground`, every `sidebar-*` — lives on `:root` only and follows its target into each theme. Re-declaring it in the dark blocks would only create a second place for it to drift. The structural test enforces both halves: every non-alias token is in all three blocks, and no alias is overridden.

**DS-05 — `destructive` and `negative` are not interchangeable.** They share a hue and mean different things: `destructive` is an action the user might regret, `negative` is a number that went down. A loss is not a warning, and a delete button is not a performance figure.

**DS-06 — The focus ring is the primary hue, never a neutral.** `--ring` is `var(--primary)`, so it stays visible on every surface it can land on. Every interactive primitive is tested for it.

**DS-45 — The brand never sits on a figure** (SPEC-022 BR-022-28). A navy number would read as a link, or as a third kind of gain. Figures are `foreground`, or `positive`/`negative` with their sign (DS-09). The brand marks what the user can *do* — a button, a link, the current destination, focus.

## 3. Theming

Three states (DL-03). An explicit user choice wins; with no choice the system preference decides.

```
:root                               → light
@media (prefers-color-scheme: dark)
  :root:not(.light)                 → system dark
.dark                               → explicit dark, wins over both
```

**DS-07 — Never give a token its only definition inside a media query or a `.dark` block.** Define it on `:root` first, then override. A token that exists only in dark is a light-theme gap.

**DS-46 — The dark theme is layered, never one black plane** (BR-022-29). Page (`background`, L 0.17), card (`card`, 0.215) and raised (`popover`, 0.265) step up in lightness, with `sidebar` (0.195) between page and card. A card is visible because it is lighter than the page, not because it has a border.

**DS-08 — The two dark blocks must stay identical.** CSS cannot share one block between a media query and a class, so the duplication is permanent. [`tests/structural/design-tokens.test.ts`](../../tests/structural/design-tokens.test.ts) fails the build if they drift — which is what makes the duplication safe. A token changed in one block and not the other yields a theme that is correct until the user touches the toggle: it passes review, it passes a screenshot, and it breaks for exactly the users who went looking for the setting.

The `dark:` Tailwind variant is redefined in `globals.css` to match all three states, so `dark:` utilities work under system preference and not only when the class is present.

## 4. Colour

### Gain and loss

**DS-09 — Green is up and red is down, and colour never carries the meaning alone.** Every figure that uses `positive`/`negative` also renders a sign or an arrow (`+`, `−`, `▲`, `▼`). Green/red matches every Brazilian broker, so changing it would make the product read as wrong (DL-05); WCAG 1.4.1 is satisfied by the redundant cue, not by abandoning the convention. `Money` *(PR2)* enforces this in one place so no screen can forget it.

### The brand under colour-vision deficiency

**DS-49 — The navy stays distinguishable from gain, loss and in-progress under protanopia and deuteranopia, by measurement** (BR-022-28). [`tests/structural/design-token-colour.test.ts`](../../tests/structural/design-token-colour.test.ts) paints each token to 8-bit sRGB, applies the Machado, Oliveira & Fernandes (2009) matrices at severity 1.0 in linear RGB, and asserts the OKLab distance from `primary` to `positive`, `negative` and `progress` stays above 0.03 in both themes. The approved palette sits at gain 0.160, loss 0.165, in-progress 0.035: the floor is below those so the test guards regressions rather than re-litigating the approval. The same file asserts 4.5:1 for every text pair the tokens promise and 3:1 for `input`, in both themes — axe in the browser only measures pairs that are rendered.

### Status

**DS-47 — A status badge uses a status colour: `success`, `progress`, `warning`, `danger` or `neutral`** (SPEC-022 BR-022-31). Each is text on its own `-surface`, ≥ 5.5:1 in both themes, and `Badge` has a variant per status. **A warning is never `negative` or `destructive`**: an open reconciliation divergence, a wallet drifting out of tolerance and an unpriced holding are `warning`; a failed import and `ErrorState` are `danger`. `negative` is a figure and `destructive` an action (DS-05), and reusing either for a status tells the user they lost money or are about to delete something. A structural test fails the build on a `Badge` in `src/app/` that uses either.

`progress` is violet, never the brand hue, so an in-progress badge cannot be mistaken for a button. `dot` adds the component sheet's leading dot, `aria-hidden`: it reinforces the colour and never replaces the words.

**One concept, one wording** (BR-022-32). An estimated figure is labelled `common.estimated` — "Estimado" — on every screen, beside the figure it qualifies. Whether the *cost* or the *value* was estimated is said by that placement and by the badge's explanation, which stay distinct (SPEC-007 BR-007-06, SPEC-009). [`tests/structural/one-estimated-label.test.ts`](../../tests/structural/one-estimated-label.test.ts) fails on a second catalogue string for the same label.

### Navigation

**DS-48 — The sidebar's active item is a fill (`nav-active`); focus is a ring (`ring`).** (Route tabs mark the current tab with an underline, or a raised `card` fill on a pill row — never the ring; DS-27.) Different tokens, different shapes, so the current destination and the keyboard position can be on different items without either being mistaken for the other (BR-022-33). Hover uses the neutral `accent`, so it cannot pass for "active" either. Paired with DS-27's `aria-current`.

### Categorical charts

**DS-10 — The eight chart tokens are the Okabe–Ito palette, bound one-to-one and permanently to the eight asset classes.** Ações, FIIs, BDRs, ETFs, Tesouro Direto, CDB, LCI, LCA. Not per chart, not per report — an asset class is the same colour everywhere in the product, or two reports contradict each other.

Okabe–Ito was chosen because its colour-vision-deficiency validation is already done and published (DL-04). The values are stored **in hex rather than oklch** specifically so they stay auditable against the source; converting them would make it impossible to tell at a glance whether they are still the published palette.

Verified against the M10 surfaces: light `card` is unchanged (white) and dark `card` moved from L 0.21 to 0.215, so every series keeps its previous contrast within 0.1.

Two caveats carried forward:

- The eighth Okabe–Ito colour is black, which no dark theme can use. `--chart-8` is a neutral that flips per theme instead.
- `--chart-4` (yellow, `#f0e442`) is low-contrast on a light background. Chart wrappers *(PR2)* must give series a stroke rather than relying on fill alone.

**DS-11 — A ninth category means a redesign, not a ninth colour.** Eight distinguishable hues is roughly the ceiling for categorical encoding. Beyond it, group into "Outros" and drill down.

## 5. Typography and numerals

**DS-12 — No webfont.** The system stack is Tailwind's `--font-sans` default, which the project deliberately does not override (DL-07). No network cost, no layout shift, and no deferred design decision blocking the work.

**DS-13 — Money and quantities render with `tabular-nums`.** With proportional digits a column of values does not line up on the decimal point, which makes a ledger unreadable. This applies to table cells and to `Money` *(PR2)*, and it is independent of the typeface.

## 6. Density

**DS-14 — Tables are compact; forms are comfortable** (DL-13). A position list should show twenty rows, not eight. A form should keep its tap targets. Both are tokens, not magic numbers:

| Token | Utility | Use |
|---|---|---|
| `--spacing-row` | `py-row` | Table cell padding |
| `--spacing-field` | `py-field` | Form control padding |

## 7. Primitives

**DS-15 — Primitives are vendored, not imported.** shadcn/ui is a catalogue of source files, not a dependency: the CLI copies a file into `src/components/ui/` and its involvement ends. Those files are ours — edited, reviewed in PRs, and never auto-updated. Behaviour comes from `radix-ui`, which *is* a dependency; appearance comes from Tailwind and `class-variance-authority`.

**DS-16 — Adapt vendored code to the project rather than the reverse.** The registry ships English strings, its own token names and its own conventions. Reconciling them is part of adding a primitive, not a follow-up.

**DS-17 — Primitives hold no string literals** (AR-44). Enforced by ESLint on `src/components/**/*.tsx`. A hardcoded string in a primitive is wrong once in the source and wrong on every screen that renders it — `Dialog`'s close label arrived from the registry as `"Close"` and is now `common.close`.

**DS-18 — Add a primitive only when composition genuinely fails.** The order to try: use an existing primitive → compose two → add a variant → add a pattern → add a primitive. A new primitive is a permanent maintenance obligation with four rendered states to keep honest.

**DS-50 — `Popover` and `DropdownMenu` are the raised layer** (M10). Both are vendored onto `radix-ui`, fill from `popover` and cast `--shadow-raised`. `Popover` carries `InfoTip` (DS-55); `DropdownMenu` carries the scope selector and, from [#205](https://github.com/rafaelfqueiroz/allmywallet/issues/205), the account menu. Escape closes either and returns focus to its trigger (WCAG 1.4.13).

**DS-51 — A select never clips its own value** (SPEC-022 BR-022-22). `NativeSelect` shares `Input`'s height and padding pair (`h-8 py-1 leading-5`), so a 20px line always fits and a select and an input in one row line up. The chevron is a decoration over `appearance-none`, with its width reserved as padding so a long value stops short of it. A caller's `className` lands on the wrapper, never on the `<select>`, so no call site can reintroduce the clipping. jsdom cannot see a clipped line; the `/primitives` baseline is where it shows (DS-42).

**DS-19 — A primitive is accessible before it is pretty.** Keyboard operability, a visible focus ring, and correct roles and labels are entry requirements, not polish. This is the whole economic argument for the design system: the alternative is satisfying them once per screen, forever.

## 8. Layout and patterns

### Layout

**DS-23 — A page expresses spacing through `Stack`, `Cluster` and `Grid`, never raw utilities.** They exist because DS-22 bars `gap-4` and `md:grid-cols-2` in `src/app/`: if layout cannot be written as classes it has to be expressible as components, or the escape hatch gets used on every screen and the rule becomes decorative.

`Stack` is vertical rhythm, `Cluster` is a horizontal group that wraps, `Grid` is responsive columns. Every `Grid` variant starts at one column and widens at a breakpoint, so a caller cannot produce a four-column grid on a phone by forgetting one.

**DS-24 — Components may use raw utilities; pages may not.** The rule is a boundary, not a style preference. Inside `src/components/` the raw classes *are* the implementation — `DataTable`'s card list deliberately uses plain divs, because wrapping `dt`/`dd` in two layout components breaks the `dl` association and axe rejects it.

### Patterns

| Pattern | Contract |
|---|---|
| `PageShell` | The page's `<main>`, its header, and **one width** for every destination — DS-57. No width prop and no `className`. Signed-in pages import it from `@/app/page-shell`, which reports the page's masking to the frame (DS-59). |
| `PageHeader` | The `<h1>`, a description, the scope slot and the primary actions on the right (BR-022-14). `PageShell` renders its header through it, so there is one header. |
| `RouteTabs` | A destination's tasks as links, one URL per tab, the active one `aria-current="page"` — DS-52. `variant="pill"` is the second row beneath them, a section's tasks (Configurações). |
| `ScopeSelector` | All wallets or one, as the `wallet` URL parameter — DS-53. |
| `AppShell` | The application frame. One nav definition (`nav-items.ts`), rendered as a collapsible sidebar from `md` and a Dialog-based drawer below it, and a **top bar** at every width whose right side holds two slots: `topBarActions` (the masking toggle) and `account` (the account menu) — DS-58. Owns the skip link. |
| `AccountMenu` | The Google name, e-mail and picture; Conta, Preferências, Privacidade, the guide, the theme switch and Sair — DS-58. Every action is a prop. |
| `EmptyState` | `role="status"`. Explains an absence. |
| `ErrorState` | `role="alert"`. Explains a failure. |
| `Section` | A titled region drawn as a **panel**: `h2` and `actions` on a header row, the body, an optional `footer` — DS-38. `variant="plain"` for the exceptions DS-38 lists. |
| `StatCard` | One headline figure as `dt`/`dd`. Owns framing, never formatting — pass a `<Money>`. `link` adds a footer row to the destination that owns the figure (BR-022-07) — DS-65. `inset` for a figure inside a panel: a muted tile with no border of its own (DS-38). |
| `SummaryCard` | A card that is a region of the page: `section` with an `h2`, a status badge or action beside the heading, and an optional `CardLink` footer to the owning destination (BR-022-07) — DS-65. `CardHeaderLink` is the link beside a heading. |
| `DataTable` | A real table from `md`, a labelled card list below it. `caption` is required. Sorts, paginates and filters, with its state in the URL — DS-54. |
| `Money` | The only place a figure becomes text. Pages import it from `@/app/money`, which applies the account's masking (DS-59). |

**DS-25 — An absence and a failure are different components.** `EmptyState` is `role="status"`; `ErrorState` is `role="alert"`. Only one of them is worth retrying, and rendering them the same way tells the user nothing about which they are looking at. This is why SPEC-011 forbids a misleading zero: "R$ 0,00" and "we have no data for this period" look identical and mean opposite things.

**DS-26 — Every destination lives in `nav-items.ts`.** The sidebar and the drawer render the same array, so they cannot disagree about what exists. Only routes that exist are listed, because a menu whose items 404 is worse than a shorter menu. SPEC-022 BR-022-01's five destinations therefore arrive with the issue that makes each route real, and the items a destination absorbs leave in the same change. What belongs to the person rather than to a feature — Conta, Preferências, Privacidade — is not a destination and lives in the account menu (BR-022-10).

**DS-27 — Active navigation state is `aria-current="page"`, not just a background colour.** Styling the active item without it makes the state sighted-only. Matching is on a path boundary, so `/wallets/abc` lights up `/wallets` and `/importar-outro` does not light up `/import`. The sidebar's look is `navItemClassName` (DS-48); `RouteTabs` marks the current tab with an underline (main) or a raised fill (pill), never the focus ring; `tests/e2e/frame.spec.ts` compares the active item's computed style across every destination, arrived at by URL and by click, and checks keyboard focus adds the ring and changes nothing else (BR-022-33).

**DS-57 — One page width, and a page never chooses its own** (SPEC-022 BR-022-14). `PageShell` is `max-w-7xl`, centred, with one padding pair, on every destination. #33's three named widths stopped the drift but kept the choice, and the choice is what the 2026-10-09 walkthrough measured: Relatórios began about 426px from the edge and Painel about 574px. A paragraph or a form that wants a shorter measure constrains itself (`max-w-prose` inside `EmptyState`, a `Field`'s own width) and leaves the page's edge alone. `tests/structural/one-page-width.test.ts` bars `max-w-*`, `mx-auto` and `w-screen` from every file in `(app)` and `(settings)`, and `tests/e2e/frame.spec.ts` measures the rendered edge on every destination at 1920px. Pages outside the frame keep their own shells (DS-39).

**DS-58 — The account menu holds what belongs to the person, and its state changes are forms** (BR-022-09/10/11). It shows what Google supplied (SPEC-001 BR-001-05) and nothing else. Sair and the guide's help entry change server state — the `sessions` row, `onboarding_dismissed_at` — so each is a `<form>` submission that no GET, prefetch or crawler can trigger. The forms sit *outside* the menu content and the items submit them through the `form` attribute, because Radix unmounts the content the moment an item is chosen. The theme switch is three `menuitemradio` items: the class changes on the click and `ui.theme` is saved behind it (DS-29); a refused save puts back the theme the account last confirmed — never an earlier, unsaved selection — and only the newest choice may change the screen when its save answers. Every action is a prop wired in `src/app/authenticated-frame.tsx` (DS-02), and a visitor with no session gets no menu.

**DS-28 — The card list is a second rendering, not responsive classes.** Both renderings are always in the DOM and CSS picks one. That costs markup and buys correctness on resize and in print, without a viewport-width hook — which would be wrong on the server and would force every consumer to be client-rendered on a guess.

**DS-52 — A destination with more than one task uses `RouteTabs`; its tabs are links** (BR-022-15). Each tab is a URL a user can reload, bookmark and open in a new tab, so a tab is never Radix `Tabs` state. `Tabs` remains for switching views *within* one task. Active matching is DS-27's path boundary, with `exact` for an overview tab that is the parent of its siblings. `preserveParams` carries named query parameters, the scope above all, across a tab switch. **No destination uses a vertical sub-navigation** (BR-022-16 as amended, DL-022-18): a destination whose sections have tasks of their own — Configurações — puts the sections in the main row and each section's tasks in a `variant="pill"` row beneath, with the section's primary action at the end of that row (#241).

**DS-53 — The scope is the `wallet` query parameter, written by `ScopeSelector` alone** (BR-022-17, DL-022-09). The parameter name is `PARAM.wallet` from `src/lib/report-url-state.ts`, the one SPEC-011 already parses; "all wallets" is its absence. Selecting navigates (`router.push`), because a new scope is a new server result. Every other parameter survives the change.

**DS-54 — A collection is a paginated `DataTable`, and its URL mirrors its state** (BR-022-18). Pagination is on by default — 10 rows, a choice of 10/25/50 kept in the URL (DS-67) — in both renderings; `pagination={false}` is for a list that is bounded by construction, and says so at the call site. A `filter` adds a text search over string columns and `toolbar` holds any other filter. Sort, page, size and query are written with `history.replaceState`, not the router: the rows are already loaded, and a router navigation would re-run the page's queries on every click. `paramPrefix` keeps two tables on one page apart. Parsing never throws (`src/lib/table-url-state.ts`): an unreadable value is the default.

**DS-66 — A collection too large to load whole is a server-paged `DataTable`** (BR-022-18, SPEC-006 BR-006-07, #214). Pass `server={{ total }}` and the rows of one page, already sorted and filtered by the query. The URL is then the only state: sort headers and page numbers are links, the page size navigates with `router.push`, and the server parses the same parameters with the same `TableUrlOptions` before it queries (`ledgerViewFrom` in `src/lib/transactions-url-state.ts`). A column the query cannot order by sets `enableSorting: false`, which also keeps it out of the URL. The search belongs to the query, so it lives in `toolbar` as a GET form that carries `sort` and `size` and drops `page`, never in `filter`. Cells that hold money arrive rendered from the server (`LedgerTable`), so no amount crosses the client boundary as a number. Every column declares a `meta.kind` (DS-67). Forms in cells are still barred (DS-28 renders each cell twice); a row checkbox joins a form outside the table through its `form` attribute.

**DS-67 — A column is its `kind`, and its width is the definition's, never the content's** (SPEC-022 BR-022-18 / DL-022-17, #237). `meta: { kind }` is `text`, `date`, `badge`, `number`, `money`, `percent` or `control` (a checkbox or row actions; default `text`) and it decides everything else, so no column picks an alignment. Text, dates and badges sit left; numbers, amounts and percentages sit right in `tabular-nums` (DS-13), and a header sits like its column. Each kind has a default width in `ch` (`data-table-columns.ts`), overridable with `meta.width` — a number is characters of content, a string a CSS length — and the table is `table-layout: fixed` with the widths in a `<colgroup>` (`TableColGroup`), so hiding the amounts (BR-022-24) moves no column. A `money` column is sized for thirteen digits — `R$ 12.345.678.901,23` — with a sign, and the masked `R$ ••••••` (BR-022-26) is narrower than that; a column that outgrows the container scrolls inside its own wrapper and a figure is never squeezed. A text, date or badge cell that does not fit ends in an ellipsis (`TruncatedCell`) and its full text opens on hover, keyboard focus and tap, through the mechanics `InfoTip` uses (`useTipInteraction`); only a cell that actually overflows is a tab stop, a cell holding a link keeps the link as its stop, and a number is never truncated. Multi-line cell content truncates each line itself (`truncate` on the line), because an ellipsis belongs to the block that holds the text. Every table whose rows grow with the portfolio is paginated at 10, 25 or 50 — default 10, kept in the URL — and only a table of a few fixed rows (the value decomposition, the benchmarks) is not, which it says where it opts out (`pagination={false}`). A plain table that is not a `DataTable` passes `fixed` to `Table` with its own `TableColGroup` and follows the same kinds' widths through `columnWidth`; `fixed` stays opt-in, because fixed layout without widths gives every column the same width. A table that closes on a total (Rentabilidade's contribution, Proventos by group) passes `totals`: a footer row over the whole collection, on every page and never filtered, repeated under the card list rather than as one of its records. A table over server-rendered cells — Portfólio, Configurações, Relatórios — is a `NodeTable` (`src/components/patterns/node-table.tsx`), whose figures sort by integer rank keys from `ranksOf`/`rankKeys` (`src/lib/rank-keys.ts`) and never by the amount; a deep link to a row uses `rowAnchor`; row controls are links or buttons joined to a form by `form=`, the forms sitting after the table (`RowForms`) — or, for a row with several actions, items of a "⋯" `RowMenu`, where `RowMenuSubmit` calls `requestSubmit()` on the form by id, because a menu unmounts its button before a native submit would fire (BR-022-41); a table that does not fit at 1280 px merges columns — a detail on a second line under the cell it belongs to — rather than scrolling (BR-022-41, DL-022-25); and a table closes its panel, so nothing follows it inside one. **Text that is not the cell's own inline text still ends in an ellipsis** (#237 review F1): a cell whose content is a flex container or a badge marks its lines `data-cell-line` (`CellLabel`, `patterns/cell-label.tsx`, for a name with a badge beside or under it) and `truncated-cell.css` truncates them and the badge, scoped to the table cell so the card rendering still wraps; the cell is a tab stop when any of those overflows. Text sorts by pt-BR collation (`table-sorting.ts`, the table's `defaultColumn`), not by code point, and equal figures share a rank (`ranksOf`) so ties keep their order in both directions. A table whose cells hold **forms** (the import batch's rows) is a server-paged `NodeTable` with `cards={false}`: single-rendered, so each form exists once and DS-28's repeated ids never arise; it scrolls inside its panel on a phone. A `DataTable` with no rows and no `empty` shows the catalogue's empty state, never bare headers over "Mostrando 0–0 de 0".

### Theme

**DS-29 — The theme is decided in two places, deliberately.** `ThemeScript` runs synchronously in `<head>` from `localStorage` so nobody watches a white page repaint to dark; `ThemeSync` reconciles that guess with the account's stored `ui.theme` after hydration, which is what makes the setting follow a user to a new device. `'system'` stamps no class at all, so the OS keeps control — including when it changes mid-session. The switch lives in the account menu (BR-022-30, DS-58) and writes the same key Preferências renders, through the same validated `setConfigValue`, so the two cannot disagree.

**DS-59 — Masking is decided by the server, and every amount passes through one of its doors** (SPEC-022 BR-022-24..27, DL-022-06/07). `ui.hide_values` is a user-level registry key; the eye toggle in the top bar is a `<form>` whose action writes it and revalidates the layout, so the next render arrives already masked. Nothing is hidden in the browser — an amount hidden by CSS or swapped after hydration was in the HTML, which BR-022-25 forbids.

- **`Money` from `@/app/money`** reads the preference with `useHideValues()` — `use()` on a `React.cache`d read, once per request — and renders a `currency` figure as `MoneyMask`: `R$ ••••••` (`MASKED_CURRENCY`, in the import-free `src/i18n/masked.ts`), the same text for every value, with an `sr-only` "Valor oculto". The frame cannot hand the value down: layouts and pages render in parallel, and a client navigation renders a page without its layout. Quantities and percentages stay. A signed figure loses its sign and colour while masked — both would single out an exact zero, and the sign would make it narrower. The pattern in `src/components/patterns/money.tsx` takes `masked` as a prop and stays free of the session (DS-02).
- **Charts** take `masked` as a prop from the Server Component that renders them, and spread `valueChartProps(masked)` (DS-33). The same render rescales their coordinates to 0–100 with `concealSeries`, so the RSC payload carries the shape and no amount, and the labels can never disagree with the coordinates. Never read the frame for this: it is a layout, and a client-side navigation does not re-render it.
- **The eye toggle** shows `useMasked()` from the frame's `MaskingProvider`, which every signed-in page updates through `PageShell` from `@/app/page-shell` (`MaskingSync`), so a value changed in another tab or on another device is reflected on this tab's next navigation.
- **A string** — a `title`, a cell for a Client Component, a phrase in a translation — comes from `currencyText(masked)`. Prefer an element: a string has no accessible name.

- **An edit form that round-trips a stored amount** — a goal's amount, a watch rule's thresholds, a transaction's price and fees — is replaced by `RevealValuesForm` while masked: one sentence and a "Mostrar valores" button that writes the same key. Rendering the input empty is not an option: the form would submit the blank as the new amount.

Exports never read the key (BR-022-27). Preferências revalidates the layout on save, so the frame's toggle and the charts' context follow a change made there. `tests/structural/amounts-are-masked.test.ts` holds pages to these doors; `tests/e2e/hide-values.spec.ts` fetches every signed-in page's HTML, unmasked and then masked, and finds no figure after `R$` but the catalogue's own copy, no chart coordinate and no edit input carrying an amount.

**DS-30 — A new user preference is a registry key, not a component.** `ui.theme` is a `ZodEnum` at `levels: ['user']`, and the SPEC-002 preferences screen renders it with no other change. Adding a bespoke settings control would fork a surface that is currently generated. **Which screen a key renders on is its registry `surface`** (SPEC-022 BR-022-13, DL-022-10): `preferences` for personal preferences — theme, reminders, display defaults — and `settings.import`, `settings.wallets` or `settings.watch` for a parameter that tunes a feature with a Configurações section. Every surface is rendered by `ParameterForm` (`src/app/parameter-form.tsx`), mounted on exactly one page, so a new key with a surface needs no screen change; `registry.test.ts` requires a surface on every user-level key and `preferences-catalogue.test.ts` requires a page for every surface. A feature with no Configurações section keeps its keys in Preferências.

## 9. Charts

**DS-31 — A chart is inaccessible by construction, so `ChartContainer` is not optional.** An SVG of coloured wedges carries its entire message in a form a screen reader cannot read. The container supplies the accessible name, a required `summary` holding the same figures as text, and a bounded height — Recharts' `ResponsiveContainer` collapses to zero inside an unbounded parent, which is the most common way a chart ships invisible.

**DS-32 — Import the palette; never pass a literal colour to a chart.** `assetClassColor()` and `chartColorAt()` are the only sources. Series that are not asset classes — benchmarks, wallets — take slots in order from `CHART_SERIES_COLORS`.

**DS-33 — Spread the shared props.** `chartAxisProps`, `chartGridProps`, `chartTooltipProps` and `chartMarkProps` exist so two reports cannot arrive at different tick formatting and different tooltip chrome. `chartMarkProps` carries the background-coloured stroke that keeps `--chart-4` (Okabe–Ito's yellow) legible on a light background. A chart whose value axis is money also takes a `masked` prop and spreads `valueChartProps(masked)`'s `valueAxis` on its `YAxis` and `valueTooltip` on its `Tooltip`, after the shared props, and the page hands it coordinates through `concealSeries` (DS-59). `tests/structural/amounts-are-masked.test.ts` fails a money chart that does not.

**A money chart reads reais** (SPEC-022 BR-022-38, DL-022-23). The axis ticks are abbreviated reais from `formatAxisCurrency` — "R$ 250 mil", "R$ 1,2 mi", whole reais below one thousand — because a tick is a scale mark and may be formatted from the coordinate. The tooltip is a figure, so it never is: every point carries a `tip` — its date (`dd/mm/yyyy`, or "setembro de 2026" for a month) and the exact amount per series, with centavos — built on the server by `chartTip` from the `Money` (AR-09), and `valueChartProps` renders that string. Masked, `chartTip` writes the placeholder and the axis reads it too. A chart whose axis is not money formats its own ticks in pt-BR and reuses the same `tip` through `chartTipTooltip()` — the benchmark comparison reads each line's cumulative return, never the rebased level.

**DS-34 — Legends render as text below the plot on small screens.** An in-chart legend on a 375px viewport consumes the plot area it exists to explain. `ChartLegend` pairs each swatch with a label and marks the swatch `aria-hidden` — it carries nothing the label does not.

## 10. Forms and pages

**DS-36 — A labelled control is a `Field`.** It takes the id, points the label at it, and attaches hint and error text with `aria-describedby`. The hint is not printed under the control — see DS-55. The pattern it replaced — wrapping the control in a `<label>` — works until someone adds a hint inside the wrapper, at which point the accessible name silently becomes the label plus the hint.

`Field` takes the control as a **child element and clones it**, not as a render prop: these forms are Server Components, and a function child cannot cross the server/client boundary. `id` is required for the same reason — `useId` is a hook, and making `Field` a Client Component would drag every form on every page with it.

**DS-55 — Instructions sit behind an `InfoTip` beside the label; errors never do** (SPEC-022 BR-022-20/21, DL-022-08). A hint printed under its control made that field taller than its neighbours and broke the row. `Field` now renders the hint inside `InfoTip`, which opens on hover, on keyboard focus and on tap, stays open while the pointer moves onto it, and closes on Escape (WCAG 1.4.13). The hint text also stays in the DOM, hidden, as the control's `aria-describedby`, so a screen reader reads it with the field without opening anything. The label row is one 20px line box and the icon's layout box is 20px, so only a label that wraps can make a field taller. A validation error renders inline under the control in `danger`, always visible. `Field` stays a Server Component; `InfoTip` is its client child. A group of controls — a set of checkboxes, which no `<label for>` can name — is a `FieldGroup`: the same contract on a `fieldset`, named by its `legend` alone, with the icon beside it and the error under the controls.

**DS-56 — A file field is a `FileUpload`** (BR-022-23). A native `<input type="file">`, transparent, covers a pt-BR drop zone: click and drag-and-drop work without JavaScript, the form posts natively (DS-37), and the browser's English "Choose Files" is never painted. With JavaScript the zone adds the dragging state, the chosen files and the pending state. Its own `title` and `acceptHint` are props, so the component holds no B3-specific text.

**DS-60 — A fixed column beside a fluid one is a `Split`, and it breaks on its container, not the viewport** (SPEC-022 BR-022-16, #210). `side="end"` a panel beside a list, `side="even"` a task beside its reference in two equal halves (Importar › Enviar's upload beside the B3 guide, #211); `side="aside"` a main column beside a narrower one that still holds lists, 3:2 (the Painel's queue beside its status cards, #213); below the container breakpoint it is one column. A page's content column is narrower than the viewport by the sidebar, so a viewport breakpoint would put a table and a form side by side in 360px — and DS-22 bars `grid-cols-[…]` in `src/app/`. The fluid track is `minmax(0,1fr)`, so a wide table scrolls inside its own container.

**DS-61 — A colour field is a `ColorInput`, never a bare `<Input type="color">`** (BR-022-20). It is the native control at `Input`'s `h-8` with the `border-input` boundary (3:1 on card and page in both themes, the token table, pinned by `design-token-colour.test.ts`) and its hex shown as text beside it, because a bare colour well on a dark card is a near-invisible black square and a colour must not be the only way to read a colour. `noneLabel` adds **"Sem cor"** — a checkbox posting `noColor=on` — because a native colour input cannot be empty and every colourless record would be saved black; picking a colour unchecks it, and the server action, not the script, maps `noColor` to `null`, so it holds without JavaScript (DS-37).

**DS-62 — A user-chosen colour beside a name is a `ColorSwatch`** (#210). The colour is data, applied through `style` — the one place a colour is not a token — and is decoration (`aria-hidden`): the name carries the identity. No colour is an empty ring with the `border-input` boundary, never a black dot, which would read as a choice.

**DS-68 — Every create or edit form has one layout: `FormPanel`, `FormGrid`, `FormActions`** (SPEC-022 BR-022-37, DL-022-21, #238). Three layouts used to coexist — a four-column grid with the buttons on the right, stacked fixed-width fields with the buttons on the left, full-width fields — and these three pieces are now the whole vocabulary (`src/components/patterns/form-layout.tsx`):

- **`FormPanel`** is a `Section` panel (DS-38) with the form's title and description. Its `alert` — the refusal that is not about one field (BR-022-21) — opens the body, above the fields; its `footer` holds the `FormActions`. The `<form>` wraps the panel, so the footer's buttons are inside it and post without JavaScript (DS-37). `ActionForm`'s `panel` prop does this for a Server Component; a Client Component with its own `useActionState` renders `FormPanel` inside its `<form>`.
- **`FormGrid`** is two columns, labels above, breaking on its **container** at `@xl` (DS-60): a form beside a list is one column. A short field takes one column; a long one — free text, a list of choices, a select whose options are sentences — takes both with `Field span="full"`. With an odd count the last field spans only if it is long; a short one leaves its neighbour cell empty. `legend` turns a group of fields inside a long form into a named `fieldset` (Nova transação's Ativo · Instituição · Operação) — one panel, never one per group. `Field width` is not used inside it.
- **`FormActions`** puts a destructive action **alone at the left** and, at the right, `status` (a save's "Alterações salvas."), **Cancelar, then the primary action, last**. Every standard form has Cancelar: a **link back** where the form is its own page or an editor opened from a list (Nova transação, Editar regra, Renda fixa back to the Painel), a native **`type="reset"`** where it sits on a page among other blocks (Atribuir ativo, a goal, the targets, the parameters — which re-mount from what was loaded, not from a refused draft). The one exception is Importar › Enviar, whose frame draws Enviar alone: a reset cannot clear a chosen file's preview. A destructive action that belongs to the edited record **submits a form of its own through the button's `form` attribute** (Excluir carteira, Excluir objetivo), that form rendered after the edit form — a form cannot hold another. Never `formAction` on the edit form: the destructive button comes first in the footer, so it would be that form's default button and Enter in any field would press it (#238 review).

What is **not** a create or edit form, and keeps its inline shape: a **filter bar** — Transações' and Relatórios' controls, Composição's grouping, Objetivos' year — which is a `<form method="get">` that asks for a view; a **row's control** inside a table or beside the list it adds to — the import batch's classify and assign cells, Accept adjustment, a wallet's "Definir regra" above its rules table; a **confirmation** whose primary action is itself the destructive one (Excluir transação); and a form **inside a panel that holds more than it** — the upload within an onboarding step, which on Importar › Enviar is its own standard panel (`UploadForm panel`).

**DS-63 — A button in a row of fields is a `FieldAction`** (BR-022-20). Fields in a row align from the top, so an error under one makes only that field taller instead of dragging its neighbours down to sit beside the error text. `FieldAction` gives the button the same one-line label row, empty, so its top edge is the inputs'.

**DS-64 — A tab can stay current on pages that are not tabs: `RouteTab.alsoActiveOn`** (DS-27, #210). Carteiras' "Nova carteira" form is part of "Minhas carteiras"; with no tab lit the reader would not know where they are. It names extra path prefixes — nothing else changes how a tab matches.

**DS-65 — A card links through a row, never a padded button** (SPEC-022 BR-022-07, #213). The link to the destination that owns a card's detail is `CardLink`: a full-width row under a hairline, its label flush with the card's left edge and a chevron at the right. `Button variant="link"` carries its own horizontal padding, which put every "Ver o relatório…" on the old Painel visibly indented off the heading above it. A card link's `ariaLabel`, when two cards would otherwise share a name, must begin with the visible label (WCAG 2.5.3); one that does not is dropped. `tests/e2e/dashboard.spec.ts` measures the edge.

**DS-37 — Form controls are native.** `NativeSelect` and `Checkbox` exist alongside the Radix `Select`, and the reason is not taste: every form on these screens is a `<form action={serverAction}>` that posts without JavaScript, and a Radix control contributes nothing to a native submission without a mirrored hidden input. Reach for Radix `Select` when the control drives client state; reach for the native one when it is a form field.

**DS-38 — A titled region within a page is a `Section`, and a `Section` is a panel** (SPEC-022 BR-022-36, #236; amended). `h2` under `PageShell`'s `h1`. Nesting deeper is a signal the page is doing too much, not a reason to add a level prop. A region drawn as a card — the Painel's — is a `SummaryCard`, which is the same `section` + `h2` inside a card (DS-65).

Every block of content below the tabs sits in a panel: an 8px `card` surface, the title and its actions on a header row above a hairline, the body, and an optional `footer` — pagination, a link, the actions that apply to the whole block — under another. Only the page title, its description and the tabs sit outside. A table, a list or a chart is put in a `Section`; a collection's panel is titled with its count, as the frames draw it ("5 carteiras"). What qualifies one block — a note about its figures — goes inside that block's panel.

**Never a panel inside a panel.** Three cases, and each is written down where it happens:

- A **group of panels** — Portfólio's class cards, Proventos' figure per type, a wallet's goals or balance, a wallet's settings — is a `Section variant="plain"`: a heading on the page, with its actions, above blocks that are each the panel.
- A **figure inside a panel** — a goal's three figures, an import's counts — is `StatCard inset`, a muted tile with no border.
- A **table inside a panel** goes straight in; a `Card` around it is the nested panel.

Three things may still sit between panels, because none is a block of content: a **page-wide `Note`** whose subject is the whole page rather than one panel (Relatórios' gross-of-tax disclosure, Observar preços' disclosures, the Painel's stale-import prompt); an **`EmptyState`/`ErrorState` that replaces the page's content** (signed out, a wallet not found, an empty scope); and **navigation and filters** — a back link, a controls bar drawn as a `Card` (Relatórios' `Controls`, Composição's grouping), which stays available on an empty scope where no panel exists to carry it. Pages outside the application frame — the landing page (DS-43), the privacy policy, `AuthShell` (DS-39) — use `variant="plain"`: a legal text reads as one document, and `AuthShell` is already a card.

**Panel review amendments (#236):** mobile `DataTable` rows are flat rows separated by hairlines; empty states inside panels have no second border. A table owns its semantic pagination footer and aligns it with the containing panel edges while retaining its own pagination state. Report-wide treatment navigation precedes headline figures; divergence and Dietz disclosures sit inside their respective headline cards. Filter controls precede bulk selection actions.

**DS-39 — Pages outside the application frame use `AuthShell`.** Sign-in is a viewport-centred card with no navigation, which is a different shape from `PageShell`'s top-aligned document. Collapsing them would produce a component whose props contradict each other half the time. The public landing page is a third shape again and uses `MarketingShell` (DS-43).

**DS-40 — Never read the session in the root layout.** A cookie read there opts *every* route into dynamic rendering — it silently turned `/` and `/signin` from prerendered into server-rendered. Per-account state belongs in a route-group layout; `src/app/authenticated-frame.tsx` is where `AppShell` and the theme reconciliation live.

**DS-43 — Marketing sections live in `src/components/marketing/`, and consume the system rather than extending it.** The landing page is a different product from the application: unauthenticated, conversion-shaped, and built from sections — hero, feature grid, trust points, closing call to action — that no other screen will ever render. Those sections are not `ui/` primitives and not `patterns/`; a pattern with exactly one caller is a page filed in the wrong directory.

What they *may not* do is invent. Colour, spacing, type and the primitives all come from the system, and a treatment the system lacks is added to the system — `CardTitle`'s `asChild`, which turns a card title into a real heading, came from this page needing a navigable outline and is now available everywhere. The one sanctioned local override is the hero's oversized call to action, commented where it happens: a landing page's primary action has no competition on the screen, and sizing it from the toolbar scale is what makes marketing look like a settings panel.

**DS-44 — `/` is prerendered, and stays that way.** It is the only page in the product written for someone who has not signed in, so it is the only one whose speed and indexability are load-bearing. Nothing in it reads the session, the cookies or the database. The signed-in visitor is redirected by `src/middleware.ts` *before* the page is looked up — a cookie-presence check, never an authorisation decision, on a matcher covering `/` and nothing else (#37).

## 11. Testing

The `components` vitest project — jsdom, Testing Library, `vitest-axe` — runs blocking alongside unit, integration and isolation. `pnpm test:components`.

**DS-20 — Every primitive and every pattern carries an axe assertion, a variants test and, if interactive, a focus-ring assertion.** Dialog, Select and Tabs additionally carry keyboard tests, because Radix behaviour is the reason those three are vendored rather than hand-written. `AppShell` carries them because navigation that cannot be operated from a keyboard is unusable, not merely awkward.

This is not ceremony. The `dlitem` failure in `DataTable`'s card list — `dt`/`dd` separated from their `dl` by two wrapper divs — was found by the axe assertion and by nothing else; it renders correctly and reads as unlabelled values to a screen reader.

**DS-21 — Components are tested inside the real i18n provider with the real pt-BR catalogue**, never a stub. AR-44 only means something if the key a component uses actually resolves; a stub would let `common.close` ship to production as literal text.

Note that the `components` project matches both `.test.ts` and `.test.tsx` under `src/components/`. The `unit` project excludes that directory wholesale, so a `.test.ts` there would otherwise be collected by no project and silently never run.

**What this harness cannot see.** jsdom has no layout and no paint, so `color-contrast` is explicitly disabled in [`test-utils.tsx`](../../src/components/test-utils.tsx) rather than left to report "incomplete" and read as a pass. That gap is covered by two browser suites.

**DS-41 — `tests/e2e/` runs axe against the real pages, on desktop and on a phone.** Composition produces violations that no per-primitive test can see, and the navigation is a genuinely different component below `md`.

**DS-42 — `tests/visual/` baselines are recorded and verified in the pinned Playwright container, never natively.** macOS and Linux rasterise fonts differently, so a baseline captured on a laptop fails in CI forever — and fails in a way that reads as a real regression. `pnpm test:visual:docker` is the only sanctioned way to record them; `--update` re-records after an intended change.

The subjects are `/primitives` — a kitchen-sink route rendering every primitive in every variant in one document, so four images (light/dark × desktop/mobile) cover the system — and `/`, the one page whose composition a visitor judges the product by. The route is gated behind `ALLOW_DEV_ROUTES`, **not** `NODE_ENV`: the standalone server the visual suite runs against *is* a production build, so a `NODE_ENV` guard 404s the very page the screenshots are of.

**DS-22 — No raw colour or spacing literal outside `src/components/`.** Enforced by ESLint on `src/app/**/*.tsx`, landed in the same commit as the retrofit so there was never a window in which fresh duplication could be added. This is the rule that stops the whole problem from restarting: without it, the system is built once and the next screen begins recreating it by hand.

The patterns match **values**, not prefixes. `text-sm`, `text-right`, `border-b`, `sr-only`, `tabular-nums` and the `py-row`/`py-field` density tokens are all legal — they are typography, alignment, structure and named tokens. `text-muted-foreground`, `gap-4` and `p-6` are not.

Two implementation notes worth keeping:

- The regexes are written without `[...]` classes or `{n,m}` quantifiers. They are embedded in esquery attribute selectors, where a literal `]` or `,` ends the selector early — the first draft matched a **truncated** pattern and let real violations through while appearing to work.
- **There is no escape hatch, and the retrofit needed none.** Every one of the 26 violations the rule found was fixed by moving the decision into a component, which is what produced `Text`, `List`, `Checkbox`, `NativeSelect` and `Field`'s `width` variants. A rule whose exemption gets used routinely is not a rule.

**DS-35 — Components may use raw utilities; pages may not.** The boundary is the point. Inside `src/components/` the raw classes *are* the implementation. `DataTable`'s card list deliberately uses plain divs, because wrapping `dt`/`dd` in two layout components breaks the `dl` association and axe rejects it.
