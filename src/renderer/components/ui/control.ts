/**
 * Class lists shared by the buttons and the form controls, so focus, hover and disabled look the same
 * wherever a control appears. Components compose these rather than restating them.
 */

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'danger-secondary' | 'link';
export type ButtonSize = 'sm' | 'md';

/**
 * Every interactive control. The focus ring is an outline rather than a box-shadow, so it survives forced
 * colours and moves nothing, and it appears for keyboard focus only.
 */
export const controlBase =
  'transition-colors motion-reduce:transition-none disabled:opacity-50 ' +
  'focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1';

export const buttonBase =
  'inline-flex shrink-0 cursor-default select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium ' +
  controlBase;

export const buttonVariants: Record<ButtonVariant, string> = {
  default: 'border border-border bg-bg-raised text-text hover:bg-bg-sunken',
  primary: 'border border-accent bg-accent text-accent-text hover:opacity-90',
  // No fill or visible outline. The transparent border keeps a ghost the same size as a default button beside it.
  ghost: 'border border-transparent bg-transparent text-text hover:bg-bg-sunken',
  // accent-text is the label colour on any solid fill, so the danger fill uses it as well.
  danger: 'border border-danger bg-danger text-accent-text hover:opacity-90',
  // The outline form of danger, for a destructive action that sits among ordinary controls rather than in a dialog.
  'danger-secondary': 'border border-danger bg-bg-raised text-danger hover:bg-bg-sunken',
  // Link is text inside a sentence: no box, so the size's height and padding are dropped, and no border either.
  link: 'h-auto px-0 text-accent underline-offset-2 hover:underline',
};

export const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1 px-2 text-sm',
  md: 'h-8 px-3',
};

export const iconButtonSizes: Record<ButtonSize, string> = {
  sm: 'size-7',
  md: 'size-8',
};

export const iconSizes: Record<ButtonSize, string> = {
  sm: 'size-3.5',
  md: 'size-4',
};

/** Text inputs, textareas and the select trigger: one height, border and surface. */
export const fieldControl =
  'h-8 w-full min-w-0 rounded-md border border-border bg-bg-raised px-2.5 text-text ' +
  'placeholder:text-text-muted aria-invalid:border-danger ' +
  controlBase;
