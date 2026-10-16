/**
 * Sets tooltip timing for the whole window: 400ms before the first tooltip shows, and almost none when the pointer
 * moves between neighbouring triggers. Radix throws if a Tooltip renders without this above it, so UiProvider
 * mounts it once at the root.
 */

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}
