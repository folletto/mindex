/**
 * A message that stays on the page until the situation changes, such as a library that needs attention or a
 * save that failed. Things that happen and then go away are toasts instead. By default danger announces itself
 * at once (role "alert") and the other tones are polite (role "status"); the role prop overrides that.
 * Icons inherit the colour of their wrapper, so the tone is set on the wrapper, never on the icon.
 */

import { CircleAlert, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../../lib/cn.js';

export type BannerTone = 'info' | 'warning' | 'danger';

interface BannerLook {
  surface: string;
  icon: string;
  Icon: LucideIcon;
  role: 'status' | 'alert';
}

const looks: Record<BannerTone, BannerLook> = {
  info: { surface: 'border-border bg-bg-sunken', icon: 'text-text-muted', Icon: Info, role: 'status' },
  warning: {
    surface: 'border-warning-border bg-warning-bg',
    icon: 'text-text',
    Icon: TriangleAlert,
    role: 'status',
  },
  danger: { surface: 'border-danger bg-bg-raised', icon: 'text-danger', Icon: CircleAlert, role: 'alert' },
};

export interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  tone?: BannerTone;
  role?: 'status' | 'alert';
  /** An optional action, such as "Retry", placed after the message. */
  action?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

export function Banner({ tone = 'info', role, action, className, children, ref, ...props }: BannerProps) {
  const look = looks[tone];
  const Icon = look.Icon;
  return (
    <div
      ref={ref}
      role={role ?? look.role}
      className={cn('flex items-start gap-2.5 rounded-md border px-3 py-2', look.surface, className)}
      {...props}
    >
      <span className={cn('mt-0.5 flex shrink-0', look.icon)}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
