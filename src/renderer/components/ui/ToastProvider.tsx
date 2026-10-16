/**
 * Notifications for things that happened, shown at the bottom of the window and then gone. One at a time: a new
 * show() replaces the one on screen. The toast is keyed by a counter, so Radix treats a replacement as a new
 * message and announces it, instead of quietly changing the text of the old one.
 */

import { X } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button.js';
import { IconButton } from './IconButton.js';
import { ToastContext, type ToastApi, type ToastOptions } from './toast-context.js';

const DEFAULT_DURATION_MS = 8000;

interface ActiveToast extends ToastOptions {
  id: number;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveToast | null>(null);
  const lastId = useRef(0);

  const show = useCallback((options: ToastOptions) => {
    lastId.current += 1;
    setActive({ ...options, id: lastId.current });
  }, []);
  const dismiss = useCallback(() => setActive(null), []);
  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <ToastPrimitive.Provider>
        {active ? (
          <ToastPrimitive.Root
            key={active.id}
            data-testid="toast"
            duration={active.durationMs ?? DEFAULT_DURATION_MS}
            onOpenChange={(open) => {
              // Only the toast that is still current may clear the slot; a replaced one closing late must not.
              if (!open) setActive((current) => (current?.id === active.id ? null : current));
            }}
            className="flex w-full items-center gap-3 rounded-md border border-border bg-bg-raised py-1.5 pr-1.5 pl-3 text-text shadow-pop"
          >
            <ToastPrimitive.Description className="min-w-0 flex-1">{active.message}</ToastPrimitive.Description>
            {active.actionLabel ? (
              <ToastPrimitive.Action asChild altText={active.actionLabel}>
                <Button size="sm" onClick={active.onAction}>
                  {active.actionLabel}
                </Button>
              </ToastPrimitive.Action>
            ) : null}
            <ToastPrimitive.Close asChild>
              <IconButton icon={X} label="Dismiss" size="sm" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ) : null}
        <ToastPrimitive.Viewport
          label="Notifications"
          className="fixed bottom-4 left-1/2 z-[60] flex w-[24rem] max-w-[calc(100vw_-_2rem)] -translate-x-1/2 flex-col gap-2 outline-none"
        />
      </ToastPrimitive.Provider>
    </ToastContext>
  );
}
