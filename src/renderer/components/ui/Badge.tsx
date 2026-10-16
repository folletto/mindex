/**
 * A short status word, such as a count or a state. Each tone pairs token colours, so it reads correctly in
 * both schemes without a dark: variant.
 */

import type { HTMLAttributes, Ref } from 'react';
import { cn } from '../../lib/cn.js';

export type BadgeTone = 'neutral' | 'ok' | 'warning' | 'danger';

const tones: Record<BadgeTone, string> = {
  neutral: 'border-border bg-bg-sunken text-text-muted',
  ok: 'border-ok text-ok',
  warning: 'border-warning-border bg-warning-bg text-text',
  danger: 'border-danger text-danger',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  ref?: Ref<HTMLSpanElement>;
}

export function Badge({ tone = 'neutral', className, ref, ...props }: BadgeProps) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-sm leading-5 font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
