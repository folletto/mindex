/**
 * One option of a RadioGroup, with its label and an optional description. The label is a real <label> bound to
 * the radio, so clicking the words selects the option, and the description is linked as the radio's description.
 */

import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useId, type ComponentPropsWithoutRef, type ReactNode, type Ref } from 'react';
import { cn } from '../../lib/cn.js';
import { controlBase } from './control.js';
import { Label } from './Label.js';

export interface RadioItemProps extends Omit<ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>, 'children'> {
  label: ReactNode;
  description?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function RadioItem({ label, description, id, className, ref, ...props }: RadioItemProps) {
  const generatedId = useId();
  const itemId = id ?? generatedId;
  const descriptionId = `${itemId}-description`;

  return (
    <div className="flex items-start gap-2.5">
      <RadioGroupPrimitive.Item
        ref={ref}
        id={itemId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          'mt-0.5 flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-bg-raised disabled:cursor-default',
          'data-[state=checked]:border-accent',
          controlBase,
          className,
        )}
        {...props}
      >
        <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-accent" />
      </RadioGroupPrimitive.Item>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={itemId} className="text-base font-normal">
          {label}
        </Label>
        {description ? (
          <p id={descriptionId} className="text-sm text-text-muted">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
