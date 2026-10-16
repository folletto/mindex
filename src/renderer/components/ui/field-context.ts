/**
 * How a Field hands its id, description and error state to the control it wraps. Kept out of Field.tsx so
 * the controls can read it without importing the component that provides it.
 */

import { createContext, useContext, type AriaAttributes } from 'react';

export interface FieldControlState {
  controlId: string;
  describedBy: string | undefined;
  invalid: boolean;
}

export const FieldContext = createContext<FieldControlState | null>(null);

/** What a caller may have passed to a control. Anything left out is filled in from the surrounding Field. */
export interface ControlAttributeSource {
  id?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
}

export interface ControlAttributes {
  id: string | undefined;
  'aria-describedby': string | undefined;
  'aria-invalid': AriaAttributes['aria-invalid'];
}

/**
 * The id and ARIA a control should render with. Inside a Field the control takes the Field's id, so the
 * visible label names it, and the Field's hint or error is appended to any description the caller set.
 * Outside a Field the caller's own values pass straight through.
 */
export function useControlAttributes(own: ControlAttributeSource): ControlAttributes {
  const field = useContext(FieldContext);
  return {
    id: own.id ?? field?.controlId,
    'aria-describedby': joinIds(own['aria-describedby'], field?.describedBy),
    'aria-invalid': own['aria-invalid'] ?? (field?.invalid ? true : undefined),
  };
}

export function joinIds(...ids: (string | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length > 0 ? present.join(' ') : undefined;
}
