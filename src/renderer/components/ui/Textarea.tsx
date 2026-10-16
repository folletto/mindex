/**
 * A multi-line text field in the token style. Like Input, it takes its label and description from a Field.
 */

import type { Ref, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';
import { fieldControl } from './control.js';
import { useControlAttributes } from './field-context.js';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, ref, ...props }: TextareaProps) {
  const attributes = useControlAttributes(props);
  return (
    <textarea
      ref={ref}
      {...props}
      {...attributes}
      className={cn(fieldControl, 'h-auto min-h-20 resize-y py-1.5', className)}
    />
  );
}
