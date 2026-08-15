import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      // A skeleton is a visual placeholder for content that is not there yet.
      // Announcing it reads as gibberish, so it is hidden from assistive tech;
      // the loading *state* is announced by the pattern that owns it, not here.
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
