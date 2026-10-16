/**
 * A region of the workspace that fills its parent. It holds a PaneHeader and then the content; put the part that
 * scrolls in a child below the header, so the title stays where it is.
 */

import type { HTMLAttributes, Ref } from 'react';
import { cn } from '../../lib/cn.js';

export interface PaneProps extends HTMLAttributes<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
}

export function Pane({ className, ref, ...props }: PaneProps) {
  return (
    <div ref={ref} className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-bg text-text', className)} {...props} />
  );
}
