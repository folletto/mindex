/**
 * A visible label. It is a real <label> bound to its control, which is what gives the control its accessible
 * name; a styled div would look the same and name nothing.
 */

import type { LabelHTMLAttributes, Ref } from 'react';
import { cn } from '../../lib/cn.js';

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  ref?: Ref<HTMLLabelElement>;
}

export function Label({ className, ref, ...props }: LabelProps) {
  return <label ref={ref} className={cn('text-sm font-medium text-text select-none', className)} {...props} />;
}
