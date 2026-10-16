/**
 * The title row of a Pane: a heading, an optional description, and the pane's actions on the right.
 * The title is an h2 so assistive technology can move between panes. The container is a div, not a header:
 * a header outside a sectioning element is a page banner, and several panes would make several banners.
 * titleTestId is the hook the e2e suite selects panes by.
 */

import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../../lib/cn.js';

export interface PaneHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleTestId?: string;
  ref?: Ref<HTMLDivElement>;
}

export function PaneHeader({ title, description, actions, titleTestId, className, ref, ...props }: PaneHeaderProps) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex min-h-12 shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3',
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        <h2 data-testid={titleTestId} className="truncate text-base font-semibold text-text">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-sm text-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
