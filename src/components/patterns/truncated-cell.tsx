'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useTipInteraction } from '@/components/patterns/use-tip-interaction';

/**
 * What a cell reads as in full: its text nodes, one space between each, so two
 * lines stacked in a cell ("PETR4" over "Petrobras") do not run together.
 */
function fullText(element: HTMLElement): string {
  const parts: string[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

interface Overflow {
  readonly overflowing: boolean;
  /** The content has a control of its own, which is then the tab stop. */
  readonly focusable: boolean;
  readonly text: string;
}

const FITS: Overflow = { overflowing: false, focusable: false, text: '' };

/**
 * Whether the content outgrows its box, re-measured after every render and
 * whenever the box is resized. The box is whatever the column's fixed width
 * leaves, so a window resize changes the answer without any render.
 */
function useOverflow(ref: RefObject<HTMLDivElement | null>): Overflow {
  const [state, setState] = useState<Overflow>(FITS);

  const measure = () => {
    const element = ref.current;
    if (!element) return;
    const overflowing = element.scrollWidth > element.clientWidth;
    const next: Overflow = overflowing
      ? {
          overflowing,
          focusable: element.querySelector(FOCUSABLE) !== null,
          text: fullText(element),
        }
      : FITS;
    // Same answer, same object: keeps a measuring render from rendering again.
    setState((previous) =>
      previous.overflowing === next.overflowing &&
      previous.focusable === next.focusable &&
      previous.text === next.text
        ? previous
        : next,
    );
  };

  // A different cell's content in the same position (sorting, paging) changes
  // the answer, and the box does not resize when it does.
  useEffect(measure);

  useEffect(() => {
    const element = ref.current;
    // jsdom and very old browsers have none; the render-time measure still runs.
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // `measure` only reads `ref`; the observer is for the element's lifetime.
  }, []);

  return state;
}

/**
 * SPEC-022 BR-022-18 / DL-022-17 — a text cell that ends in an ellipsis when it
 * does not fit its column, and whose full text opens on hover, on keyboard
 * focus and on tap (`useTipInteraction`, the same mechanics as `InfoTip`).
 *
 * **Only a cell that actually overflows is interactive.** A table of fifty rows
 * and eight text columns would otherwise gain four hundred tab stops for text
 * that is already fully visible. An overflowing cell is a tab stop; its
 * `tabIndex` is the touch route too — a tap focuses it, which opens the text.
 *
 * **A cell holding a control keeps that control as its focus target.** A link
 * in the cell is reached, activated and announced as itself; the popover opens
 * when focus lands on it (`focus` bubbles) and on hover, and nothing is added
 * between the link and the keyboard.
 *
 * The full text is already in the DOM, so a screen reader reads the cell whole
 * and this popover is for sighted users: it is `aria-hidden` rather than read
 * a second time (BR-016-16 spirit — what a cell says never depends on it).
 */
export function TruncatedCell({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { overflowing, focusable, text } = useOverflow(ref);
  const tip = useTipInteraction(contentRef);

  return (
    <Popover open={overflowing && tip.open} onOpenChange={tip.onOpenChange}>
      <PopoverAnchor asChild>
        <div
          ref={ref}
          data-slot="table-cell-text"
          {...(overflowing
            ? {
                ...tip.trigger,
                onClick: tip.pin,
                ...(focusable ? {} : { tabIndex: 0 }),
              }
            : {})}
          className={cn(
            // `min-w-0` and the clipping are what make the ellipsis happen
            // inside a fixed-width column.
            'min-w-0 truncate rounded-sm',
            overflowing &&
              !focusable &&
              'outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          )}
        >
          {children}
        </div>
      </PopoverAnchor>
      {overflowing && (
        <PopoverContent
          ref={contentRef}
          role="tooltip"
          aria-hidden="true"
          side="bottom"
          align="start"
          className="w-auto max-w-80 text-sm break-words"
          // Focus stays on the cell: stealing it on a hover-open would pull the
          // keyboard user out of the row they are reading.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // The cell is the anchor, not a trigger Radix knows: pressing on it
          // is not an "outside" press that dismisses the text it just opened.
          onInteractOutside={(event) => {
            if (event.target instanceof Node && ref.current?.contains(event.target)) {
              event.preventDefault();
            }
          }}
          {...tip.content}
        >
          {text}
        </PopoverContent>
      )}
    </Popover>
  );
}
