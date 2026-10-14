import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Section, type SectionProps } from '@/components/patterns/section';

/**
 * SPEC-022 BR-022-37 / DL-022-21 — **every create or edit form has one
 * layout**: a panel with a title; fields in a two-column grid, labels above,
 * a short field in one column and a long one across both; a footer with
 * Cancelar, then the primary action, at the right, and a destructive action
 * alone at the left. One column on a narrow screen.
 *
 * Three layouts coexisted before this (#238): a four-column grid with the
 * buttons on the right, stacked fixed-width fields with the buttons on the
 * left, and full-width fields. These three pieces are the whole vocabulary,
 * so a form cannot pick a fourth.
 *
 * All three are Server Components with no state: a form posts natively
 * (DS-37), and the `<form>` element — `ActionForm`, or a Client Component's
 * own `useActionState` form — wraps the panel, so the footer's buttons are
 * inside it and submit it without JavaScript.
 */

/**
 * The panel a form sits in: a `Section` (BR-022-36), whose `footer` holds the
 * form's `FormActions` and whose header `actions` stay free for the panel's
 * own links. `alert` is the form-level refusal — anything not about
 * one field (BR-022-21) — and opens the body, above the fields: a refusal
 * below a submit button, on a form long enough to scroll, is a refusal the
 * user never sees.
 */
export function FormPanel({
  alert,
  children,
  ...props
}: Omit<SectionProps, 'variant'> & {
  /** The form-level refusal, rendered first in the body. */
  readonly alert?: React.ReactNode;
}) {
  return (
    <Section {...props}>
      {alert}
      {children}
    </Section>
  );
}

/**
 * Two columns, labels above. A short field takes one column; a long one —
 * free text, a list of choices, a select whose options are sentences — takes
 * both with `Field span="full"`. Fields are as wide as their column, so
 * `Field width` is not used here (it stays for inline filter bars).
 *
 * When the count is odd, the last field spans both columns only if it is long;
 * a short one leaves its neighbouring cell empty rather than stretching to a
 * width that says something about its content it does not mean (#238).
 *
 * **The breakpoint is the container's** (DS-60): a panel beside a list, or
 * inside a sub-navigated destination, is narrower than the viewport, and a
 * viewport breakpoint would put two fields side by side in 300px. Rows align
 * from the top, so an error under one field makes only that field taller
 * (BR-022-20/21).
 */
export function FormGrid({
  legend,
  description,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  /**
   * Names a group of fields inside a long form — Nova transação's Ativo,
   * Instituição and Operação. The grid becomes a `fieldset` named by it, so
   * the group is announced with each of its fields; the panel stays one.
   */
  readonly legend?: React.ReactNode;
  /** Said under the legend: what the group's fields have in common. */
  readonly description?: React.ReactNode;
}) {
  const grid = (
    <div data-slot="form-grid-container" className="@container w-full">
      <div
        data-slot="form-grid"
        className={cn('grid grid-cols-1 items-start gap-4 @xl:grid-cols-2 *:min-w-0', className)}
        {...props}
      />
    </div>
  );
  if (legend === undefined) return grid;
  return (
    <fieldset data-slot="form-fieldset" className="min-w-0">
      <legend className="text-sm font-semibold">{legend}</legend>
      {description !== undefined && (
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      )}
      <div className="mt-3">{grid}</div>
    </fieldset>
  );
}

/**
 * The footer's button row. The destructive action sits **alone at the left**
 * — the furthest point from the primary action, so it is never the button the
 * hand was moving towards. At the right, **Cancelar, then the primary action**
 * (`children`), the primary last — where the eye ends the form (BR-022-37).
 *
 * `status` is a save's quiet confirmation ("Alterações salvas."), at the left
 * of the right-hand group so it reads beside the button that produced it.
 * On a narrow screen the row wraps and the right-hand group keeps its order.
 */
export function FormActions({
  destructive,
  cancel,
  status,
  children,
  className,
}: {
  /** A destructive action — Excluir, Cancelar importação. Alone, at the left. */
  readonly destructive?: React.ReactNode;
  /** Cancelar: a link back, or a reset. Before the primary action. */
  readonly cancel?: React.ReactNode;
  /** A live status beside the buttons, such as a save's confirmation. */
  readonly status?: React.ReactNode;
  /** The primary action, last. */
  readonly children?: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="form-actions"
      className={cn('flex flex-wrap items-center justify-between gap-2', className)}
    >
      {destructive !== undefined && (
        <div data-slot="form-actions-destructive" className="flex items-center gap-1">
          {destructive}
        </div>
      )}
      <div
        data-slot="form-actions-main"
        className="ml-auto flex flex-wrap items-center justify-end gap-2"
      >
        {status}
        {cancel}
        {children}
      </div>
    </div>
  );
}
