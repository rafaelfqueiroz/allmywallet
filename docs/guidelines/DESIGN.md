# Design System

How the interface is built. The prose companion to [`src/app/globals.css`](../../src/app/globals.css) and [`src/components/`](../../src/components/).

Rules are numbered `DS-nn` and are citable from code and PRs the same way `AR-`, `DV-` and `TS-` rules are. The scoping decisions behind them are recorded as `DL-nn` in the Decision log of [#33](https://github.com/rafaelfqueiroz/allmywallet/issues/33); where this document explains *what the rule is*, the Decision log explains *why that option was chosen over the others*.

> **Status.** Complete. All three PRs under [#33](https://github.com/rafaelfqueiroz/allmywallet/issues/33) have landed: tokens and primitives, layout/patterns/shell/charts, and the retrofit with its enforcement. Every rule below describes code that exists.

## 1. What this is, and what it is not

Five layers. The design system owns the first four. The fifth belongs to the specs.

| Layer | Where | Owns |
|---|---|---|
| Tokens | `src/app/globals.css` | Named values — colour, radius, density. No opinion about usage |
| Primitives | `src/components/ui/` | Button, Input, Select, Label, Table, Card, Badge, Dialog, Tabs, Skeleton |
| Layout | `src/components/layout/` | Stack, Grid, Cluster — the only sanctioned way a page expresses spacing |
| Patterns | `src/components/patterns/` | PageShell, AppShell, EmptyState, ErrorState, DataTable, StatCard, Money, theme |
| Charts | `src/components/charts/` | The palette binding, ChartContainer, ChartLegend and the shared axis/tooltip props |
| **Pages** | `src/app/` | Screen composition. **Not part of the design system** |

**DS-01 — The test for whether something belongs in the system is whether a second, unrelated screen would need the exact same thing.** A focus ring: yes. A donut chart above a filtered position table: no — that is one report's answer to one spec, and it lives in `src/app/`.

**DS-02 — A primitive knows nothing about the domain.** `Button` has never heard of a wallet. The exception is deliberate and narrow: `Money` is a domain primitive, because AR-09's round-once-at-display rule needs exactly one home.

**DS-03 — Marketing is not the design system.** The landing page ([#37](https://github.com/rafaelfqueiroz/allmywallet/issues/37)) consumes tokens and primitives but its sections live in `src/components/marketing/`. Hero blocks are not reused by anything.

## 2. Tokens

**DS-04 — A component never hardcodes a colour, a radius or a raw pixel.** Every value comes from a token. Tailwind v4 reads them from `@theme`, so a token is also a utility: `--color-positive` gives `text-positive`, `--spacing-row` gives `py-row`.

The vocabulary is shadcn's, adopted wholesale rather than renamed (DL-02), plus four project additions.

| Token | Means |
|---|---|
| `background` / `foreground` | The page and its text |
| `card` / `popover` (+ `-foreground`) | Raised surfaces |
| `primary` (+ `-foreground`) | The main action colour. Placeholder hue — DL-08 defers the brand |
| `secondary`, `muted`, `accent` (+ `-foreground`) | Recessive surfaces, in increasing order of emphasis |
| `destructive` (+ `-foreground`) | A dangerous **action** — delete, revoke |
| `border`, `input`, `ring` | Hairlines, field outlines, focus rings |
| `chart-1` … `chart-8` | **Project addition.** Categorical series. See §4 |
| `positive`, `negative` | **Project addition.** A gain or a loss — a **figure**, not an action |

**DS-05 — `destructive` and `negative` are not interchangeable.** They share a hue and mean different things: `destructive` is an action the user might regret, `negative` is a number that went down. A loss is not a warning, and a delete button is not a performance figure.

**DS-06 — The focus ring is the primary hue, never a neutral.** `--ring` deliberately tracks `--primary` so it stays visible on every surface it can land on. Every interactive primitive is tested for it.

## 3. Theming

Three states (DL-03). An explicit user choice wins; with no choice the system preference decides.

```
:root                               → light
@media (prefers-color-scheme: dark)
  :root:not(.light)                 → system dark
.dark                               → explicit dark, wins over both
```

**DS-07 — Never give a token its only definition inside a media query or a `.dark` block.** Define it on `:root` first, then override. A token that exists only in dark is a light-theme gap.

**DS-08 — The two dark blocks must stay identical.** CSS cannot share one block between a media query and a class, so the duplication is permanent. [`tests/structural/design-tokens.test.ts`](../../tests/structural/design-tokens.test.ts) fails the build if they drift — which is what makes the duplication safe. A token changed in one block and not the other yields a theme that is correct until the user touches the toggle: it passes review, it passes a screenshot, and it breaks for exactly the users who went looking for the setting.

The `dark:` Tailwind variant is redefined in `globals.css` to match all three states, so `dark:` utilities work under system preference and not only when the class is present.

## 4. Colour

### Gain and loss

**DS-09 — Green is up and red is down, and colour never carries the meaning alone.** Every figure that uses `positive`/`negative` also renders a sign or an arrow (`+`, `−`, `▲`, `▼`). Green/red matches every Brazilian broker, so changing it would make the product read as wrong (DL-05); WCAG 1.4.1 is satisfied by the redundant cue, not by abandoning the convention. `Money` *(PR2)* enforces this in one place so no screen can forget it.

### Categorical charts

**DS-10 — The eight chart tokens are the Okabe–Ito palette, bound one-to-one and permanently to the eight asset classes.** Ações, FIIs, BDRs, ETFs, Tesouro Direto, CDB, LCI, LCA. Not per chart, not per report — an asset class is the same colour everywhere in the product, or two reports contradict each other.

Okabe–Ito was chosen because its colour-vision-deficiency validation is already done and published (DL-04). The values are stored **in hex rather than oklch** specifically so they stay auditable against the source; converting them would make it impossible to tell at a glance whether they are still the published palette.

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

**DS-19 — A primitive is accessible before it is pretty.** Keyboard operability, a visible focus ring, and correct roles and labels are entry requirements, not polish. This is the whole economic argument for the design system: the alternative is satisfying them once per screen, forever.

## 8. Layout and patterns

### Layout

**DS-23 — A page expresses spacing through `Stack`, `Cluster` and `Grid`, never raw utilities.** They exist because DS-22 bars `gap-4` and `md:grid-cols-2` in `src/app/`: if layout cannot be written as classes it has to be expressible as components, or the escape hatch gets used on every screen and the rule becomes decorative.

`Stack` is vertical rhythm, `Cluster` is a horizontal group that wraps, `Grid` is responsive columns. Every `Grid` variant starts at one column and widens at a breakpoint, so a caller cannot produce a four-column grid on a phone by forgetting one.

**DS-24 — Components may use raw utilities; pages may not.** The rule is a boundary, not a style preference. Inside `src/components/` the raw classes *are* the implementation — `DataTable`'s card list deliberately uses plain divs, because wrapping `dt`/`dd` in two layout components breaks the `dl` association and axe rejects it.

### Patterns

| Pattern | Contract |
|---|---|
| `PageShell` | The page's `<main>`, its `<h1>`, and one of exactly three widths — `narrow`, `default`, `wide`. Replaced the five different max-widths that had accumulated across five peer screens. |
| `AppShell` | The application frame. One nav definition (`nav-items.ts`), rendered as a collapsible sidebar from `md` and a Dialog-based drawer below it. Owns the skip link. |
| `EmptyState` | `role="status"`. Explains an absence. |
| `ErrorState` | `role="alert"`. Explains a failure. |
| `StatCard` | One headline figure as `dt`/`dd`. Owns framing, never formatting — pass a `<Money>`. |
| `DataTable` | A real table from `md`, a labelled card list below it. `caption` is required. |
| `Money` | The only place a figure becomes text. |

**DS-25 — An absence and a failure are different components.** `EmptyState` is `role="status"`; `ErrorState` is `role="alert"`. Only one of them is worth retrying, and rendering them the same way tells the user nothing about which they are looking at. This is why SPEC-011 forbids a misleading zero: "R$ 0,00" and "we have no data for this period" look identical and mean opposite things.

**DS-26 — Every destination lives in `nav-items.ts`.** The sidebar and the drawer render the same array, so they cannot disagree about what exists. Only routes that exist are listed: `nav.dashboard` and `nav.transactions` have catalogue entries but no pages, and a menu whose items 404 is worse than a shorter menu.

**DS-27 — Active navigation state is `aria-current="page"`, not just a background colour.** Styling the active item without it makes the state sighted-only. Matching is on a path boundary, so `/wallets/abc` lights up `/wallets` and `/importar-outro` does not light up `/import`.

**DS-28 — The card list is a second rendering, not responsive classes.** Both renderings are always in the DOM and CSS picks one. That costs markup and buys correctness on resize and in print, without a viewport-width hook — which would be wrong on the server and would force every consumer to be client-rendered on a guess.

### Theme

**DS-29 — The theme is decided in two places, deliberately.** `ThemeScript` runs synchronously in `<head>` from `localStorage` so nobody watches a white page repaint to dark; `ThemeSync` reconciles that guess with the account's stored `ui.theme` after hydration, which is what makes the setting follow a user to a new device. `'system'` stamps no class at all, so the OS keeps control — including when it changes mid-session.

**DS-30 — A new user preference is a registry key, not a component.** `ui.theme` is a `ZodEnum` at `levels: ['user']`, and the SPEC-002 preferences screen renders it with no other change. Adding a bespoke settings control would fork a surface that is currently generated.

## 9. Charts

**DS-31 — A chart is inaccessible by construction, so `ChartContainer` is not optional.** An SVG of coloured wedges carries its entire message in a form a screen reader cannot read. The container supplies the accessible name, a required `summary` holding the same figures as text, and a bounded height — Recharts' `ResponsiveContainer` collapses to zero inside an unbounded parent, which is the most common way a chart ships invisible.

**DS-32 — Import the palette; never pass a literal colour to a chart.** `assetClassColor()` and `chartColorAt()` are the only sources. Series that are not asset classes — benchmarks, wallets — take slots in order from `CHART_SERIES_COLORS`.

**DS-33 — Spread the shared props.** `chartAxisProps`, `chartGridProps`, `chartTooltipProps` and `chartMarkProps` exist so two reports cannot arrive at different tick formatting and different tooltip chrome. `chartMarkProps` carries the background-coloured stroke that keeps `--chart-4` (Okabe–Ito's yellow) legible on a light background.

**DS-34 — Legends render as text below the plot on small screens.** An in-chart legend on a 375px viewport consumes the plot area it exists to explain. `ChartLegend` pairs each swatch with a label and marks the swatch `aria-hidden` — it carries nothing the label does not.

## 10. Forms and pages

**DS-36 — A labelled control is a `Field`.** It takes the id, points the label at it, and attaches hint and error text with `aria-describedby`. The pattern it replaced — wrapping the control in a `<label>` — works until someone adds a hint inside the wrapper, at which point the accessible name silently becomes the label plus the hint.

`Field` takes the control as a **child element and clones it**, not as a render prop: these forms are Server Components, and a function child cannot cross the server/client boundary. `id` is required for the same reason — `useId` is a hook, and making `Field` a Client Component would drag every form on every page with it.

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
