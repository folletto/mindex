/**
 * A labelled control with optional hint and error text. The label reaches its control through FieldContext
 * rather than by cloning the child, so any control that reads the context is labelled, whatever it renders.
 */

import { useId, useMemo, type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';
import { FieldContext, joinIds } from './field-context.js';
import { Label } from './Label.js';

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, className, children }: FieldProps) {
  const controlId = useId();
  const hintId = useId();
  const errorId = useId();
  const invalid = Boolean(error);
  const describedBy = joinIds(hint ? hintId : undefined, error ? errorId : undefined);
  const state = useMemo(() => ({ controlId, describedBy, invalid }), [controlId, describedBy, invalid]);

  return (
    <FieldContext value={state}>
      <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
        <Label htmlFor={controlId}>{label}</Label>
        {children}
        {hint ? (
          <p id={hintId} className="text-sm text-text-muted">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext>
  );
}
