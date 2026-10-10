import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { InfoTip } from '@/components/patterns/info-tip';

/**
 * `Field` for a group of controls — a set of checkboxes has no single control
 * a `<label for>` can point at, so it is a `fieldset` named by its `legend`.
 *
 * The same contract as `Field` (SPEC-022 BR-022-20/21): instructions behind an
 * info icon beside the legend and in the group's description, never a visible
 * paragraph that makes the group taller than its neighbours; an error inline,
 * under the controls, always visible.
 *
 * The legend stays the fieldset's first child, which is what names the group.
 * It floats so the icon can sit on its line; the icon is outside the legend so
 * its own name ("Instruções sobre …") does not become part of the group's.
 */
export function FieldGroup({
  id,
  legend,
  hint,
  error,
  children,
}: {
  /** Must be unique on the page. */
  readonly id: string;
  readonly legend: string;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly children: ReactNode;
}) {
  const legendId = `${id}-legend`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <fieldset
      data-slot="field-group"
      aria-describedby={describedBy || undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend id={legendId} className="float-left min-h-5 text-sm font-medium">
        {legend}
      </legend>
      {hint && (
        <span className="ml-1 inline-flex align-top">
          <InfoTip id={`${id}-info`} label={legend} labelledBy={legendId}>
            {hint}
          </InfoTip>
        </span>
      )}
      {hint && (
        <span id={hintId} hidden>
          {hint}
        </span>
      )}
      <div className="clear-left flex flex-col gap-1 pt-2">
        {children}
        {error && (
          <p id={errorId} className="flex items-start gap-1 text-xs text-danger">
            <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </fieldset>
  );
}
