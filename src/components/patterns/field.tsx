import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

/**
 * Named widths rather than `w-48` at the call site. Five different arbitrary
 * widths across two forms is how two date inputs end up 8px apart for no
 * reason — and DS-22 bars the literal from `src/app/` anyway.
 */
const fieldVariants = cva('flex flex-col gap-1', {
  variants: {
    width: {
      auto: '',
      xs: 'w-20',
      sm: 'w-32',
      md: 'w-44',
      lg: 'w-56',
      full: 'w-full',
    },
  },
  defaultVariants: { width: 'auto' },
});

/**
 * A labelled form control.
 *
 * Exists because the association is the part that gets dropped. Across the
 * screens this replaced, controls were labelled by *wrapping* them in a
 * `<label>` — which works, until someone adds a hint paragraph inside the
 * wrapper and the accessible name silently becomes the label plus the hint.
 * Here the label points at the control by id, and the hint is attached with
 * `aria-describedby` instead.
 *
 * The control is cloned rather than taken as a render prop: these forms are
 * rendered by Server Components, and a function child cannot cross the
 * server/client boundary. `id` is required for the same reason — `useId` is a
 * hook, and making this a Client Component to get one would drag every form
 * on every page along with it.
 */
type ControlProps = {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
};

export type FieldProps = VariantProps<typeof fieldVariants> & {
  /** Must be unique on the page. The control is given this id. */
  id: string;
  label: ReactNode;
  /** Guidance shown under the control and announced as a description. */
  hint?: ReactNode;
  /** Error text. Announced, and marks the control invalid. */
  error?: ReactNode;
  className?: string;
  children: ReactElement<ControlProps>;
};

export function Field({ id, label, hint, error, width, className, children }: FieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div data-slot="field" className={cn(fieldVariants({ width }), className)}>
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, {
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true } : {}),
      })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
