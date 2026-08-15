# Design System

How the interface is built. The prose companion to [`src/app/globals.css`](../../src/app/globals.css) and [`src/components/`](../../src/components/).

Rules are numbered `DS-nn` and are citable from code and PRs the same way `AR-`, `DV-` and `TS-` rules are. The scoping decisions behind them are recorded as `DL-nn` in the Decision log of [#33](https://github.com/rafaelfqueiroz/allmywallet/issues/33); where this document explains *what the rule is*, the Decision log explains *why that option was chosen over the others*.

> **Status.** PR1 of three has landed: tokens, the ten primitives, and the a11y/keyboard harness. Patterns, `AppShell`, charts and `<Money>` land in PR2; the retrofit of the existing screens, the strict lint rule and the visual baselines in PR3. Sections below marked *(PR2)* or *(PR3)* describe committed decisions, not existing code.

## 1. What this is, and what it is not

Five layers. The design system owns the first four. The fifth belongs to the specs.

| Layer | Where | Owns |
|---|---|---|
| Tokens | `src/app/globals.css` | Named values — colour, radius, density. No opinion about usage |
| Primitives | `src/components/ui/` | Button, Input, Select, Label, Table, Card, Badge, Dialog, Tabs, Skeleton |
| Layout *(PR2)* | `src/components/layout/` | Stack, Grid, Cluster — the only sanctioned way a page expresses spacing |
| Patterns *(PR2)* | `src/components/patterns/` | PageShell, AppShell, EmptyState, ErrorState, DataTable, StatCard, Money |
| **Pages** | `src/app/` | Screen composition. **Not part of the design system** |

**DS-01 — The test for whether something belongs in the system is whether a second, unrelated screen would need the exact same thing.** A focus ring: yes. A donut chart above a filtered position table: no — that is one report's answer to one spec, and it lives in `src/app/`.

**DS-02 — A primitive knows nothing about the domain.** `Button` has never heard of a wallet. The exception is deliberate and narrow: `Money` *(PR2)* is a domain primitive, because AR-09's round-once-at-display rule needs exactly one home.

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

## 8. Testing

The `components` vitest project — jsdom, Testing Library, `vitest-axe` — runs blocking alongside unit, integration and isolation. `pnpm test:components`.

**DS-20 — Every primitive carries an axe assertion, a variants test and, if interactive, a focus-ring assertion.** Dialog, Select and Tabs additionally carry keyboard tests, because Radix behaviour is the reason those three are vendored rather than hand-written.

**DS-21 — Primitives are tested inside the real i18n provider with the real pt-BR catalogue**, never a stub. AR-44 only means something if the key a component uses actually resolves; a stub would let `common.close` ship to production as literal text.

**What this harness cannot see.** jsdom has no layout and no paint, so `color-contrast` is explicitly disabled in [`test-utils.tsx`](../../src/components/test-utils.tsx) rather than left to report "incomplete" and read as a pass. Contrast, both themes and both viewports are covered by Playwright screenshot baselines *(PR3)*, generated in a pinned container image because macOS and CI rasterise fonts differently.

**DS-22 *(PR3)* — No raw colour or spacing literal outside `src/components/`.** A lint rule, landing in the same commit as the retrofit so there is no window in which fresh duplication can be added. This is the rule that stops the whole problem from restarting: without it, the system is built once and the next screen begins recreating it by hand.
