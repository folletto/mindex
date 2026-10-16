/**
 * A choice from a list, on Radix Select. Radix has no null: an empty string means "show the placeholder", so it
 * cannot be an item value either. The value is therefore translated here. Options carry a prefix so none can
 * collide with the "none" item, which null selects when emptyLabel is given; without emptyLabel, null shows the
 * placeholder.
 */

import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react';
import { cn } from '../../lib/cn.js';
import { fieldControl } from './control.js';
import { useControlAttributes } from './field-context.js';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>,
  'value' | 'children' | 'onChange'
> {
  value: string | null;
  onValueChange: (value: string | null) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  /** Adds a first item that selects null, and is shown as the value while the value is null. */
  emptyLabel?: string;
  name?: string;
  ref?: Ref<HTMLButtonElement>;
}

const NONE = 'none';
const OPTION = 'option:';

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  emptyLabel,
  name,
  disabled,
  className,
  ref,
  ...props
}: SelectProps) {
  const attributes = useControlAttributes(props);
  const selected = value === null ? (emptyLabel === undefined ? '' : NONE) : OPTION + value;

  return (
    <SelectPrimitive.Root
      value={selected}
      onValueChange={(next) => onValueChange(next === NONE ? null : next.slice(OPTION.length))}
      name={name}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        ref={ref}
        {...props}
        {...attributes}
        className={cn(
          fieldControl,
          'flex cursor-default items-center justify-between gap-2 text-left data-[placeholder]:text-text-muted',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} className="min-w-0 truncate" />
        <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-border bg-bg-raised shadow-pop"
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 cursor-default items-center justify-center">
            <ChevronUp aria-hidden="true" className="size-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">
            {emptyLabel === undefined ? null : <SelectItem value={NONE}>{emptyLabel}</SelectItem>}
            {options.map((option) => (
              <SelectItem key={option.value} value={OPTION + option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 cursor-default items-center justify-center">
            <ChevronDown aria-hidden="true" className="size-4" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function SelectItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <SelectPrimitive.Item
      value={value}
      className="relative flex cursor-default items-center rounded-sm py-1 pr-7 pl-2 outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-text"
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
        <Check aria-hidden="true" className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
