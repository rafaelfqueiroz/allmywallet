'use client';

import type { ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * SPEC-022 BR-022-40/41 — a table row's actions behind one "⋯" button, so a row
 * with three actions takes one control's width.
 *
 * Holds no strings (DS-17): the trigger's accessible name names the row ("Ações
 * da regra de PETR4") and each item's text is the caller's. Items are
 * `DropdownMenuItem asChild` over a link, or `RowMenuSubmit` for a form.
 */
export function RowMenu({
  label,
  children,
}: {
  /** The trigger's accessible name, naming the row it acts on. Translated. */
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} title={label}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * An item that submits a form outside the table (`RowForms`), by id.
 *
 * Not a `<button form=…>`: selecting an item closes the menu and unmounts it,
 * and a submit button removed before its click's default action submits
 * nothing. `requestSubmit()` from Radix's `onSelect` runs first and still goes
 * through the form's action, as the account menu does.
 */
export function RowMenuSubmit({
  form,
  destructive = false,
  children,
}: {
  /** The id of the form to submit. */
  readonly form: string;
  readonly destructive?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenuItem
      variant={destructive ? 'destructive' : 'default'}
      onSelect={() => {
        const target = document.getElementById(form);
        if (target instanceof HTMLFormElement) target.requestSubmit();
      }}
    >
      {children}
    </DropdownMenuItem>
  );
}
