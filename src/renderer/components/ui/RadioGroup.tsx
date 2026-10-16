/**
 * A set of mutually exclusive options on Radix: one value, arrow-key movement and a single tab stop. Name the
 * group with aria-label or aria-labelledby; each RadioItem supplies its own label.
 */

import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, Ref } from 'react';
import { cn } from '../../lib/cn.js';

export interface RadioGroupProps extends ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root> {
  ref?: Ref<HTMLDivElement>;
}

export function RadioGroup({ className, ref, ...props }: RadioGroupProps) {
  return <RadioGroupPrimitive.Root ref={ref} className={cn('grid gap-2.5', className)} {...props} />;
}
