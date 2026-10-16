/**
 * show() and dismiss() for the toast on screen. It throws outside a ToastProvider, because a toast with nowhere
 * to appear would fail silently.
 */

import { useContext } from 'react';
import { ToastContext, type ToastApi } from './toast-context.js';

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast() needs a ToastProvider above it. UiProvider supplies one.');
  return api;
}
