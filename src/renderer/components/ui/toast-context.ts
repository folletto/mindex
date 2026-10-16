/**
 * The toast API, in its own module so that useToast can read it without importing the provider component.
 */

import { createContext } from 'react';

export interface ToastOptions {
  message: string;
  /** Adds a button, such as "Undo". Pressing it runs onAction and closes the toast. */
  actionLabel?: string;
  onAction?: () => void;
  /** How long the toast stays before it closes itself. Hovering or focusing it pauses the timer. */
  durationMs?: number;
}

export interface ToastApi {
  /** Shows a toast, replacing whichever one is on screen. */
  show(options: ToastOptions): void;
  dismiss(): void;
}

export const ToastContext = createContext<ToastApi | null>(null);
