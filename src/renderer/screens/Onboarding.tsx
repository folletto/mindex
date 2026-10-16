/**
 * First launch, and the screen you land on when the library folder has moved.
 *
 * The one thing this screen has to get across is what the data folder *is*:
 * not a hidden app-support directory, but a folder the user owns, can sync,
 * and can open in Finder.
 */

import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import type { LibraryState } from '@shared/types';
import { api } from '../state/api.js';
import { Banner, Button } from '../components/ui/index.js';

interface Props {
  state: LibraryState;
}

export function Onboarding({ state }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [foreign, setForeign] = useState<{ path: string; entries: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    setBusy(true);
    setError(null);
    setForeign(null);
    try {
      const result = await api.library.choose();
      if (result.needsConfirmation === 'foreign' && result.path) {
        setForeign({ path: result.path, entries: result.entries ?? [] });
      } else if (!result.ok && result.error) {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const createSubfolder = async () => {
    if (!foreign) return;
    setBusy(true);
    try {
      const result = await api.library.create(foreign.path, 'Mindex Catalogue');
      if (!result.ok) setError(result.error ?? 'Could not create the folder.');
      else setForeign(null);
    } finally {
      setBusy(false);
    }
  };

  const openRecent = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.library.switchTo(path);
      if (!result.ok) setError(result.error ?? 'Could not open that library.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4 text-text">
      <div className="flex w-full max-w-xl flex-col gap-5 rounded-md border border-border bg-bg-raised p-6">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold text-text">Mindex</h1>
          <p className="text-lg text-text-muted">A catalogue of your things, kept in a folder you own.</p>
        </header>

        <p className="leading-relaxed">
          Everything lives in one folder: a small database file, and one subfolder per item holding its attachments.
          Put it in Dropbox, iCloud or Syncthing and several machines can share it. Open it in Finder or Explorer and
          everything is where you would expect. Nothing is stored anywhere else, and nothing leaves your computer.
        </p>

        {state.status === 'missing' && state.path && (
          <Banner tone="warning">
            The folder <code>{state.path}</code> is not there any more. It may be on a drive that is not mounted, or
            it may have moved.
          </Banner>
        )}

        {error && <Banner tone="danger">{error}</Banner>}

        {foreign && (
          <Banner tone="warning">
            <div className="flex flex-col gap-3">
              <p>
                <strong className="font-semibold break-all">{foreign.path}</strong> already has files in it, so Mindex
                will not turn it into a library — that would mix your catalogue in with whatever is already there.
              </p>
              <p className="text-sm text-text-muted">
                It contains: {foreign.entries.slice(0, 6).join(', ')}
                {foreign.entries.length > 6 ? ', …' : ''}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => void createSubfolder()} disabled={busy}>
                  Create a “Mindex Catalogue” folder inside it
                </Button>
                <Button variant="ghost" onClick={() => setForeign(null)} disabled={busy}>
                  Pick somewhere else
                </Button>
              </div>
            </div>
          </Banner>
        )}

        {!foreign && (
          <div>
            <Button variant="primary" icon={FolderOpen} onClick={() => void choose()} disabled={busy}>
              Choose folder…
            </Button>
          </div>
        )}

        {state.recent.length > 0 && (
          <section className="flex flex-col gap-2 border-t border-border pt-5">
            <h2 className="text-sm font-semibold text-text">Recent</h2>
            <ul className="flex flex-col items-start gap-1">
              {state.recent.map((path) => (
                <li key={path} className="max-w-full">
                  <Button
                    variant="link"
                    className="max-w-full text-left break-all whitespace-normal"
                    onClick={() => void openRecent(path)}
                    disabled={busy}
                  >
                    {path}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
