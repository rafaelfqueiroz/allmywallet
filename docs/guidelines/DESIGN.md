# Design System

How the interface is built. The prose companion to [`src/app/globals.css`](../../src/app/globals.css) and [`src/components/`](../../src/components/).

Rules are numbered `DS-nn` and are citable from code and PRs the same way `AR-`, `DV-` and `TS-` rules are. The scoping decisions behind them are recorded as `DL-nn` in the Decision log of [#33](https://github.com/rafaelfqueiroz/allmywallet/issues/33); where this document explains *what the rule is*, the Decision log explains *why that option was chosen over the others*.

> **Status.** Complete. All three PRs under [#33](https://github.com/rafaelfqueiroz/allmywallet/issues/33) have landed: tokens and primitives, layout/patterns/shell/charts, and the retrofit with its enforcement. Every rule below describes code that exists.
>
> **M10 amendments** ([SPEC-022](https://github.com/rafaelfqueiroz/allmywallet/wiki/SPEC-022-Interface-Design-Navigation), [#201](https://github.com/rafaelfqueiroz/allmywallet/issues/201)). [#203](https://github.com/rafaelfqueiroz/allmywallet/issues/203) replaced the palette with the one approved with the M10 prototype (SPEC-022 DL-022-13): §2–§4 below. The wiki's [Approved tokens](https://github.com/rafaelfqueiroz/allmywallet/wiki/SPEC-022-Interface-Design-Navigation#approved-tokens) table records what was approved; this document and `globals.css` hold the living values. [#204](https://github.com/rafaelfqueiroz/allmywallet/issues/204) added the components the new page structure needs — §7, §8 and §10, DS-50 to DS-56.

## 1. What this is, and what it is not

Five layers. The design system owns the first four. The fifth belongs to the specs.

| Layer | Where | Owns |
|---|---|---|
| Tokens | `src/app/globals.css` | Named values — colour, radius, density. No opinion about usage |
| Primitives | `src/components/ui/` | Button, Input, Select, NativeSelect, Label, Table, Card, Badge, Dialog, Popover, DropdownMenu, Tabs, Skeleton |
| Layout | `src/components/layout/` | Stack, Grid, Cluster — the only sanctioned way a page expresses spacing |
| Patterns | `src/components/patterns/` | PageShell, PageHeader, AppShell, AccountMenu, RouteTabs, SubNav, ScopeSelector, EmptyState, ErrorState, DataTable, StatCard, Money, Field, InfoTip, FileUpload, theme |
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
| `--radius` | `0.625rem`. Every `rounded-*` derives from it |

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

**DS-48 — The active navigation item is a fill (`nav-active`); focus is a ring (`ring`).** Different tokens, different shapes, so the current destination and the keyboard position can be on different items without either being mistaken for the other (BR-022-33). Hover uses the neutral `accent`, so it cannot pass for "active" either. Paired with DS-27's `aria-current`.

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
| `RouteTabs` | A destination's tasks as links, one URL per tab, the active one `aria-current="page"` — DS-52. |
| `SubNav` | Configurações' vertical section navigation; the same active/hover/focus treatment as the sidebar (DS-48). |
| `ScopeSelector` | All wallets or one, as the `wallet` URL parameter — DS-53. |
| `AppShell` | The application frame. One nav definition (`nav-items.ts`), rendered as a collapsible sidebar from `md` and a Dialog-based drawer below it, and a **top bar** at every width whose right side holds two slots: `topBarActions` (the masking toggle) and `account` (the account menu) — DS-58. Owns the skip link. |
| `AccountMenu` | The Google name, e-mail and picture; Conta, Preferências, Privacidade, the guide, the theme switch and Sair — DS-58. Every action is a prop. |
| `EmptyState` | `role="status"`. Explains an absence. |
| `ErrorState` | `role="alert"`. Explains a failure. |
| `StatCard` | One headline figure as `dt`/`dd`. Owns framing, never formatting — pass a `<Money>`. |
| `DataTable` | A real table from `md`, a labelled card list below it. `caption` is required. Sorts, paginates and filters, with its state in the URL — DS-54. |
| `Money` | The only place a figure becomes text. Pages import it from `@/app/money`, which applies the account's masking (DS-59). |

**DS-25 — An absence and a failure are different components.** `EmptyState` is `role="status"`; `ErrorState` is `role="alert"`. Only one of them is worth retrying, and rendering them the same way tells the user nothing about which they are looking at. This is why SPEC-011 forbids a misleading zero: "R$ 0,00" and "we have no data for this period" look identical and mean opposite things.

**DS-26 — Every destination lives in `nav-items.ts`.** The sidebar and the drawer render the same array, so they cannot disagree about what exists. Only routes that exist are listed, because a menu whose items 404 is worse than a shorter menu. SPEC-022 BR-022-01's five destinations therefore arrive with the issue that makes each route real, and the items a destination absorbs leave in the same change. What belongs to the person rather than to a feature — Conta, Preferências, Privacidade — is not a destination and lives in the account menu (BR-022-10).

**DS-27 — Active navigation state is `aria-current="page"`, not just a background colour.** Styling the active item without it makes the state sighted-only. Matching is on a path boundary, so `/wallets/abc` lights up `/wallets` and `/importar-outro` does not light up `/import`. The look is `navItemClassName` (DS-48), shared by the sidebar, `SubNav` and `RouteTabs`; `tests/e2e/frame.spec.ts` compares the active item's computed style across every destination, arrived at by URL and by click, and checks keyboard focus adds the ring and changes nothing else (BR-022-33).

**DS-57 — One page width, and a page never chooses its own** (SPEC-022 BR-022-14). `PageShell` is `max-w-7xl`, centred, with one padding pair, on every destination. #33's three named widths stopped the drift but kept the choice, and the choice is what the 2026-10-09 walkthrough measured: Relatórios began about 426px from the edge and Painel about 574px. A paragraph or a form that wants a shorter measure constrains itself (`max-w-prose` inside `EmptyState`, a `Field`'s own width) and leaves the page's edge alone. `tests/structural/one-page-width.test.ts` bars `max-w-*`, `mx-auto` and `w-screen` from every file in `(app)` and `(settings)`, and `tests/e2e/frame.spec.ts` measures the rendered edge on every destination at 1920px. Pages outside the frame keep their own shells (DS-39).

**DS-58 — The account menu holds what belongs to the person, and its state changes are forms** (BR-022-09/10/11). It shows what Google supplied (SPEC-001 BR-001-05) and nothing else. Sair and the guide's help entry change server state — the `sessions` row, `onboarding_dismissed_at` — so each is a `<form>` submission that no GET, prefetch or crawler can trigger. The forms sit *outside* the menu content and the items submit them through the `form` attribute, because Radix unmounts the content the moment an item is chosen. The theme switch is three `menuitemradio` items: the class changes on the click and `ui.theme` is saved behind it (DS-29); a refused save puts back the theme the account last confirmed — never an earlier, unsaved selection — and only the newest choice may change the screen when its save answers. Every action is a prop wired in `src/app/authenticated-frame.tsx` (DS-02), and a visitor with no session gets no menu.

**DS-28 — The card list is a second rendering, not responsive classes.** Both renderings are always in the DOM and CSS picks one. That costs markup and buys correctness on resize and in print, without a viewport-width hook — which would be wrong on the server and would force every consumer to be client-rendered on a guess.

**DS-52 — A destination with more than one task uses `RouteTabs`; its tabs are links** (BR-022-15). Each tab is a URL a user can reload, bookmark and open in a new tab, so a tab is never Radix `Tabs` state. `Tabs` remains for switching views *within* one task. Active matching is DS-27's path boundary, with `exact` for an overview tab that is the parent of its siblings. `preserveParams` carries named query parameters, the scope above all, across a tab switch.

**DS-53 — The scope is the `wallet` query parameter, written by `ScopeSelector` alone** (BR-022-17, DL-022-09). The parameter name is `PARAM.wallet` from `src/lib/report-url-state.ts`, the one SPEC-011 already parses; "all wallets" is its absence. Selecting navigates (`router.push`), because a new scope is a new server result. Every other parameter survives the change.

**DS-54 — A collection is a paginated `DataTable`, and its URL mirrors its state** (BR-022-18). Pagination is on by default — 25 rows, 10/25/50/100 — in both renderings; `pagination={false}` is for a list that is bounded by construction, and says so at the call site. A `filter` adds a text search over string columns and `toolbar` holds any other filter. Sort, page, size and query are written with `history.replaceState`, not the router: the rows are already loaded, and a router navigation would re-run the page's queries on every click. `paramPrefix` keeps two tables on one page apart. Parsing never throws (`src/lib/table-url-state.ts`): an unreadable value is the default.

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

**DS-34 — Legends render as text below the plot on small screens.** An in-chart legend on a 375px viewport consumes the plot area it exists to explain. `ChartLegend` pairs each swatch with a label and marks the swatch `aria-hidden` — it carries nothing the label does not.

## 10. Forms and pages

**DS-36 — A labelled control is a `Field`.** It takes the id, points the label at it, and attaches hint and error text with `aria-describedby`. The hint is not printed under the control — see DS-55. The pattern it replaced — wrapping the control in a `<label>` — works until someone adds a hint inside the wrapper, at which point the accessible name silently becomes the label plus the hint.

`Field` takes the control as a **child element and clones it**, not as a render prop: these forms are Server Components, and a function child cannot cross the server/client boundary. `id` is required for the same reason — `useId` is a hook, and making `Field` a Client Component would drag every form on every page with it.

**DS-55 — Instructions sit behind an `InfoTip` beside the label; errors never do** (SPEC-022 BR-022-20/21, DL-022-08). A hint printed under its control made that field taller than its neighbours and broke the row. `Field` now renders the hint inside `InfoTip`, which opens on hover, on keyboard focus and on tap, stays open while the pointer moves onto it, and closes on Escape (WCAG 1.4.13). The hint text also stays in the DOM, hidden, as the control's `aria-describedby`, so a screen reader reads it with the field without opening anything. The label row is one 20px line box and the icon's layout box is 20px, so only a label that wraps can make a field taller. A validation error renders inline under the control in `danger`, always visible. `Field` stays a Server Component; `InfoTip` is its client child.

**DS-56 — A file field is a `FileUpload`** (BR-022-23). A native `<input type="file">`, transparent, covers a pt-BR drop zone: click and drag-and-drop work without JavaScript, the form posts natively (DS-37), and the browser's English "Choose Files" is never painted. With JavaScript the zone adds the dragging state, the chosen files and the pending state. Its own `title` and `acceptHint` are props, so the component holds no B3-specific text.

**DS-37 — Form controls are native.** `NativeSelect` and `Checkbox` exist alongside the Radix `Select`, and the reason is not taste: every form on these screens is a `<form action={serverAction}>` that posts without JavaScript, and a Radix control contributes nothing to a native submission without a mirrored hidden input. Reach for Radix `Select` when the control drives client state; reach for the native one when it is a form field.

**DS-38 — A titled region within a page is a `Section`.** `h2` under `PageShell`'s `h1`. Nesting deeper is a signal the page is doing too much, not a reason to add a level prop.

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
