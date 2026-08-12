import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** The shadcn/ui class merge helper. Copied in, per DEVELOPMENT §1. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
