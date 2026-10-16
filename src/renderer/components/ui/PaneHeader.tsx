/**
 * The slim row across the top of a Pane: an optional title, an optional description, and the pane's actions on the
 * right. The section's name is not repeated here, because the top bar already shows it, so a pane passes only what it
 * adds. A title, when given, is an h2 so assistive technology can move between panes. The container is a div, not a
 * header: a header outside a sectioning element is a page banner, and several panes would make several banners.
 */

import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../../lib/cn.js';

export interface PaneHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

export function PaneHeader({ title, description, actions, className, ref, ...props }: PaneHeaderProps) {
  return (
    <div
      ref={ref}
      className={cn('flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-2.5', className)}
      {...props}
    >
      {title || description ? (
        <div className="min-w-0">
          {title ? <h2 className="truncate text-base font-semibold text-text">{title}</h2> : null}
          {description ? (
            <p className={cn('text-sm text-text-muted', title ? 'mt-0.5' : null)}>{description}</p>
          ) : null}
        </div>
      ) : null}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
