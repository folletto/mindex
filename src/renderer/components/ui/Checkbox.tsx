/**
 * A two-state checkbox on Radix, which supplies the keyboard handling and the ARIA state. It draws no text, so
 * name it with a Label (htmlFor) or an aria-label; otherwise a screen reader announces an unnamed box.
 */

import { Check } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, Ref } from 'react';
import { cn } from '../../lib/cn.js';
import { controlBase } from './control.js';

export interface CheckboxProps extends Omit<
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
  'checked' | 'defaultChecked' | 'onCheckedChange'
> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  ref?: Ref<HTMLButtonElement>;
}

export function Checkbox({ className, checked, defaultChecked, onCheckedChange, ref, ...props }: CheckboxProps) {
  // Radix can also report 'indeterminate'. This control never sets it, so only true counts as checked.
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(state) => onCheckedChange?.(state === true)}
      className={cn(
        'inline-flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-border bg-bg-raised text-accent-text disabled:cursor-default',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        controlBase,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex">
        <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
