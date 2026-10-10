import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary-hover',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive:
          'bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20',
        outline: 'border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground',
        ghost: 'hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50',
        link: 'text-primary underline-offset-4 hover:underline',
        // SPEC-022 BR-022-31 — status, as distinct from an action
        // (`destructive`) or a figure (`positive`/`negative`). Each is its text
        // colour on its own surface, ≥ 5.5:1 in both themes. A warning is
        // `warning`, never `destructive` (DS-05).
        success: 'bg-success-surface text-success',
        progress: 'bg-progress-surface text-progress',
        warning: 'bg-warning-surface text-warning',
        danger: 'bg-danger-surface text-danger',
        neutral: 'bg-neutral-surface text-neutral',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

/**
 * `dot` adds the small leading dot the SPEC-022 component sheet draws on every
 * status badge ("● Concluída"). It is decoration only — `aria-hidden`, in the
 * badge's own text colour (`bg-current`) — because the label already says what
 * the state is: the dot reinforces the colour, it never replaces the words
 * (BR-016-16). Ignored with `asChild`, where there is no element of ours to
 * put it in.
 */
function Badge({
  className,
  variant = 'default',
  asChild = false,
  dot = false,
  children,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean; dot?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {dot && !asChild && (
        <span aria-hidden data-slot="badge-dot" className="size-1.5 shrink-0 rounded-full bg-current" />
      )}
      {children}
    </Comp>
  );
}

export { Badge, badgeVariants };
