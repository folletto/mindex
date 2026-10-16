/**
 * What the primitives need from above them: tooltip timing and the toast viewport. Mount it once, at the root of
 * the app, so it sits above anything that uses IconButton, Tooltip or useToast.
 */

import type { ReactNode } from 'react';
import { ToastProvider } from './ToastProvider.js';
import { TooltipProvider } from './TooltipProvider.js';

export function UiProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ToastProvider>{children}</ToastProvider>
    </TooltipProvider>
  );
}
