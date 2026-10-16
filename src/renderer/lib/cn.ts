import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins conditional class names, then drops earlier utilities that a later one
 * overrides (`p-2 p-4` becomes `p-4`). Use it for any className built from parts.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
