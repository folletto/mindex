/**
 * The bar across the top of the workspace, to the right of the rail, naming the section on screen. It is the same
 * height as the rail's drag strip so the two read as one line, and it drags the window the same way.
 */

export interface TopBarProps {
  /** The section's name. It is also the page heading for assistive technology. */
  title: string;
}

export function TopBar({ title }: TopBarProps) {
  return (
    <header className="flex h-10 shrink-0 items-center border-b border-border px-4 app-drag">
      <h1 data-testid="pane-title" className="truncate text-base font-semibold text-text select-none">
        {title}
      </h1>
    </header>
  );
}
