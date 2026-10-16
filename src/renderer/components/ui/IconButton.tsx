/**
 * An icon-only button. The label is required because an icon alone names nothing: it becomes the aria-label
 * and the tooltip, so a sighted user and a screen reader get the same word.
 */

import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '../../lib/cn.js';
import {
  buttonBase,
  buttonVariants,
  iconButtonSizes,
  iconSizes,
  type ButtonSize,
  type ButtonVariant,
} from './control.js';
import { Tooltip } from './Tooltip.js';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  icon: LucideIcon;
  /** The accessible name, and the text of the tooltip that shows on hover and keyboard focus. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  icon: Icon,
  label,
  variant = 'ghost',
  size = 'md',
  type = 'button',
  className,
  ref,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        ref={ref}
        type={type}
        {...props}
        aria-label={label}
        className={cn(buttonBase, iconButtonSizes[size], buttonVariants[variant], className)}
      >
        <Icon aria-hidden="true" className={iconSizes[size]} />
      </button>
    </Tooltip>
  );
}
