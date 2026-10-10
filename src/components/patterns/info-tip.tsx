'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Time the pointer has to travel from the icon onto the content before the
 * content closes. WCAG 1.4.13 "hoverable": the user must be able to move onto
 * the revealed text — to read a long instruction or zoom into it — without it
 * vanishing under the pointer.
 */
const LEAVE_GRACE_MS = 150;

export interface InfoTipProps {
  /** The instructions. A node, so a Server Component can pass it across the boundary. */
  readonly children: ReactNode;
  /** Unique on the page; the icon's own id, referenced by its `aria-labelledby`. */
  readonly id: string;
  /**
   * What the instructions are about — the field's label. The icon's accessible
   * name is "Instruções sobre <label>". A string is interpolated into the
   * name directly; a node cannot be, so it falls back to `labelledBy`.
   *
   * Preferring the string is deliberate: an `aria-labelledby` that points at
   * the label makes the icon match any query for the *field's* label too
   * (`getByLabelText('Nome')` finds two elements), which is both what a test
   * and what a voice-control user saying "Nome" would trip over.
   */
  readonly label: ReactNode;
  /** Id of the element holding `label`; used only when `label` is not a string. */
  readonly labelledBy: string;
  readonly className?: string;
}

/**
 * SPEC-022 BR-022-20 / DL-022-08 — an info icon whose instructions open on
 * hover, on keyboard focus and on tap, and close on Escape, on pointer leave
 * and on blur.
 *
 * **A controlled `Popover`, not `Tooltip`.** Radix `Tooltip` does not open on
 * touch — it is built for pointer hover and focus only — so a phone user would
 * never reach the instructions. A popover opens on press, and the hover and
 * focus legs are added here on top of it.
 *
 * Three things keep the legs from fighting each other:
 *
 * - Hover is mouse/pen only. A touch tap fires `pointerenter` too, and treating
 *   it as hover would open the tip and immediately close it on the "leave".
 * - Click only ever opens. Hover and focus have usually already opened the tip
 *   by the time a mouse click lands, and a toggle would shut it in the user's
 *   face. It closes on Escape, on an outside tap or on blur instead.
 * - A tip opened by focus or click is *pinned*: pointer leave no longer closes
 *   it, so a keyboard user's tip is not dismissed by a passing mouse.
 *
 * The instructions are also present in the field's accessible description
 * (`Field` keeps a hidden `${id}-hint`), so this surface is for sighted users
 * and the icon is not what carries the information to a screen reader
 * (BR-016-16 spirit).
 */
export function InfoTip({ children, id, label, labelledBy, className }: InfoTipProps) {
  const t = useTranslations('field');
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);

  const cancelLeave = useCallback(() => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = undefined;
  }, []);

  useEffect(() => cancelLeave, [cancelLeave]);

  const close = useCallback(() => {
    cancelLeave();
    pinned.current = false;
    setOpen(false);
  }, [cancelLeave]);

  const scheduleLeave = () => {
    if (pinned.current) return;
    cancelLeave();
    leaveTimer.current = setTimeout(close, LEAVE_GRACE_MS);
  };

  const pin = () => {
    cancelLeave();
    pinned.current = true;
    setOpen(true);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          {...(typeof label === 'string'
            ? { 'aria-label': t('instructions', { label }) }
            : {
                'aria-label': t('instructions', { label: '' }).trim(),
                'aria-labelledby': `${id} ${labelledBy}`,
              })}
          data-slot="info-tip"
          onPointerEnter={(event: PointerEvent) => {
            if (event.pointerType === 'touch') return;
            cancelLeave();
            setOpen(true);
          }}
          onPointerLeave={(event: PointerEvent) => {
            if (event.pointerType !== 'touch') scheduleLeave();
          }}
          onFocus={pin}
          onClick={(event) => {
            // Radix composes its own toggle after this handler and skips it
            // when the event is default-prevented — which is how "click only
            // opens" is enforced.
            event.preventDefault();
            pin();
          }}
          onBlur={(event) => {
            // Moving focus into the content (it has none today, but a link in
            // the instructions would) is not leaving the tip.
            if (contentRef.current?.contains(event.relatedTarget)) return;
            close();
          }}
          className={cn(
            // size-6 is the touch target; the negative margin keeps the layout
            // box at the icon's 20px so it cannot grow the label row (BR-022-20).
            '-m-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:text-foreground',
            className,
          )}
        >
          <Info aria-hidden className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        role="note"
        side="top"
        align="start"
        // Focus stays on the icon: stealing it on a hover-open would pull the
        // keyboard user out of the field they are filling in.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelLeave}
        onPointerLeave={scheduleLeave}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
