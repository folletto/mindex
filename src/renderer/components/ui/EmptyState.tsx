/**
 * What a pane shows when it has nothing to show. It says why it is empty and, when there is something the user
 * can do about it, offers that action. The icon is decorative and inherits the muted text colour.
 */

import type { LucideIcon } from 'lucide-react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../../lib/cn.js';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

export function EmptyState({ icon: Icon, title, description, action, className, ref, ...props }: EmptyStateProps) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-text-muted',
        className,
      )}
      {...props}
    >
      {Icon ? <Icon aria-hidden="true" strokeWidth={1.5} className="size-8" /> : null}
      <h3 className="text-base font-semibold text-text">{title}</h3>
      {description ? <p className="max-w-[28rem] text-sm">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
