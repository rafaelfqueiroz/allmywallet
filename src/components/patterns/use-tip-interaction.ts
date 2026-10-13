'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type RefObject,
} from 'react';

/**
 * Time the pointer has to travel from the trigger onto the content before the
 * content closes. WCAG 1.4.13 "hoverable": the user must be able to move onto
 * the revealed text — to read a long instruction or zoom into it — without it
 * vanishing under the pointer.
 */
export const LEAVE_GRACE_MS = 150;

/**
 * SPEC-022 BR-022-20 / BR-022-18 / DL-022-08 — when a small floating
 * explanation (an info icon's instructions, a truncated table cell's full
 * text) is open: on hover, on keyboard focus and on tap, closing on Escape, on
 * pointer leave and on blur.
 *
 * **Shared, not copied**: `InfoTip` and `TruncatedCell` must agree on every one
 * of these rules, and a second copy is the one that drifts.
 *
 * Use it with a **controlled `Popover`** — Radix `Tooltip` never opens on
 * touch. Three things keep the legs from fighting each other:
 *
 * - Hover is mouse/pen only. A touch tap fires `pointerenter` too, and treating
 *   it as hover would open the tip and immediately close it on the "leave".
 * - Click only ever opens (`pin`). Hover and focus have usually already opened
 *   the tip by the time a mouse click lands, and a toggle would shut it in the
 *   user's face. It closes on Escape, on an outside tap or on blur instead.
 * - A tip opened by focus or click is *pinned*: pointer leave no longer closes
 *   it, so a keyboard user's tip is not dismissed by a passing mouse.
 *
 * `contentRef` is the floating content, so that focus moving into it (a link in
 * the instructions) is not mistaken for leaving the trigger.
 */
export function useTipInteraction(contentRef: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  return {
    open,
    /** For `Popover`'s `onOpenChange`: Radix asks to open or to dismiss. */
    onOpenChange: (next: boolean) => {
      if (next) setOpen(true);
      else close();
    },
    /** Open and keep open. For a click handler. */
    pin,
    close,
    /** Spread on the element that reveals the content. */
    trigger: {
      onPointerEnter: (event: PointerEvent) => {
        if (event.pointerType === 'touch') return;
        cancelLeave();
        setOpen(true);
      },
      onPointerLeave: (event: PointerEvent) => {
        if (event.pointerType !== 'touch') scheduleLeave();
      },
      onFocus: pin,
      onBlur: (event: FocusEvent<HTMLElement>) => {
        const next = event.relatedTarget;
        // Moving focus into the content, or between two focusable things inside
        // the trigger itself, is not leaving the tip.
        if (
          next instanceof Node &&
          (contentRef.current?.contains(next) || event.currentTarget.contains(next))
        )
          return;
        close();
      },
    },
    /** Spread on the floating content, so the pointer can travel onto it. */
    content: {
      onPointerEnter: cancelLeave,
      onPointerLeave: scheduleLeave,
    },
  };
}
