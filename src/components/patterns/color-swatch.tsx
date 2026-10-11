import { cn } from '@/lib/utils';

/**
 * A user-chosen colour as a small dot, beside the name it belongs to.
 *
 * The colour is **data** — a stored hex the user picked (`ColorInput`) — so it
 * is applied through `style`, the one place a colour is not a design token. It
 * is decoration: the name carries the identity, so the dot is hidden from
 * assistive technology (WCAG 1.4.1 — never the only carrier). With no colour it
 * is an empty ring rather than a black dot, which would read as a choice.
 * The ring uses `border-input`, the boundary token, so the dot is visible on
 * `card` in both themes even when the chosen colour is near the surface's.
 */
export function ColorSwatch({
  color,
  className,
}: {
  readonly color: string | null;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="color-swatch"
      className={cn('inline-block size-3 shrink-0 rounded-full border border-input', className)}
      style={color === null ? undefined : { backgroundColor: color }}
    />
  );
}
