/**
 * A single-line text field in the token style. Inside a Field it takes the Field's id and description, so its
 * visible label is also its accessible name.
 */

import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '../../lib/cn.js';
import { fieldControl } from './control.js';
import { useControlAttributes } from './field-context.js';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, ref, ...props }: InputProps) {
  const attributes = useControlAttributes(props);
  return <input ref={ref} {...props} {...attributes} className={cn(fieldControl, className)} />;
}
