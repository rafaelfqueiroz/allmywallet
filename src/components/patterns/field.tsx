import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { InfoTip } from '@/components/patterns/info-tip';

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
 * **Instructions sit behind an info icon; errors do not** (SPEC-022
 * BR-022-20/21, DL-022-08). An inline hint paragraph made a field taller than
 * its neighbours and misaligned the row (Configurações › Carteiras' "Objetivo"
 * against "Nome"). The text now lives in an `InfoTip` beside the label, and in
 * a hidden `${id}-hint` that `aria-describedby` points at — so it is still the
 * control's description whether or not anyone opens the tip. The label row has
 * a fixed height, so a field is exactly as tall with an icon as without one.
 * An error is the opposite case: it must be read, so it renders inline, under
 * the control, always visible.
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
  /** Instructions: behind an info icon beside the label, and the control's description. */
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

  const labelId = `${id}-label`;

  return (
    <div data-slot="field" className={cn(fieldVariants({ width }), className)}>
      {/* h-5 is the whole point: the row is the same height whether or not the
          icon is present (BR-022-20). */}
      <div data-slot="field-label-row" className="flex h-5 items-center gap-1">
        <Label id={labelId} htmlFor={id}>
          {label}
        </Label>
        {hint && (
          <InfoTip id={`${id}-info`} labelledBy={labelId}>
            {hint}
          </InfoTip>
        )}
      </div>
      {cloneElement(children, {
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true } : {}),
      })}
      {hint && (
        <span id={hintId} hidden>
          {hint}
        </span>
      )}
      {error && (
        <p id={errorId} className="flex items-start gap-1 text-xs text-danger">
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
