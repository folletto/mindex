/**
 * The button. Variants describe the action rather than its colour: primary is the one main action in a view,
 * danger is for anything that deletes or discards, and danger-secondary is that same action drawn as an outline for
 * when it sits among ordinary controls. The icon is decorative; the children are the name.
 */

import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '../../lib/cn.js';
import {
  buttonBase,
  buttonSizes,
  buttonVariants,
  iconSizes,
  type ButtonSize,
  type ButtonVariant,
} from './control.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Drawn before the label. Decorative, so the label is what assistive technology announces. */
  icon?: LucideIcon;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'default',
  size = 'md',
  icon: Icon,
  type = 'button',
  className,
  children,
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonBase, buttonSizes[size], buttonVariants[variant], className)}
      {...props}
    >
      {Icon ? <Icon aria-hidden="true" className={cn('shrink-0', iconSizes[size])} /> : null}
      {children}
    </button>
  );
}
