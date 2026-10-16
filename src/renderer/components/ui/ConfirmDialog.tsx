/**
 * A modal that asks before an action that cannot be undone, or that needs an explicit yes. Radix moves focus to
 * Cancel when the dialog opens, so Enter and Escape both back out, and confirming takes a deliberate press.
 * Confirming runs onConfirm and then closes the dialog.
 */

import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { Button } from './Button.js';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Say what will happen, not only what is being asked. It becomes the dialog's description for screen readers. */
  description: ReactNode;
  /** The verb for the action, such as "Move to trash". A generic "OK" does not tell the user what they are agreeing to. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Gives the confirm button the danger style. Focus starts on Cancel either way. */
  destructive?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <AlertDialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 flex w-[24rem] max-w-[calc(100vw_-_2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-md border border-border bg-bg-raised p-5 shadow-pop">
          <div className="flex flex-col gap-1.5">
            <AlertDialogPrimitive.Title className="text-lg font-semibold text-text">
              {title}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="text-base text-text-muted">
              {description}
            </AlertDialogPrimitive.Description>
          </div>
          <div className="flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button>{cancelLabel}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
