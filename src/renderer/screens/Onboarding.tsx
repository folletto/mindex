/**
 * First launch, and the screen you land on when the library folder has moved.
 *
 * The one thing this screen has to get across is what the data folder *is*:
 * not a hidden app-support directory, but a folder the user owns, can sync,
 * and can open in Finder.
 */

import { useState } from 'react';
import type { LibraryState } from '@shared/types';
import { api } from '../state/api.js';

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
    <main className="onboarding">
      <div className="onboarding-card">
        <h1>Mindex</h1>
        <p className="lead">A catalogue of your things, kept in a folder you own.</p>

        <p className="explain">
          Everything lives in one folder: a small database file, and one subfolder per item holding its
          attachments. Put it in Dropbox, iCloud or Syncthing and several machines can share it. Open it in
          Finder or Explorer and everything is where you would expect. Nothing is stored anywhere else, and
          nothing leaves your computer.
        </p>

        {state.status === 'missing' && state.path && (
          <p className="warning">
            The folder <code>{state.path}</code> is not there any more. It may be on a drive that is not
            mounted, or it may have moved.
          </p>
        )}

        {error && <p className="error">{error}</p>}

        {foreign && (
          <div className="confirm">
            <p>
              <strong>{foreign.path}</strong> already has files in it, so Mindex will not turn it into a
              library — that would mix your catalogue in with whatever is already there.
            </p>
            <p className="muted">
              It contains: {foreign.entries.slice(0, 6).join(', ')}
              {foreign.entries.length > 6 ? ', …' : ''}
            </p>
            <div className="row">
              <button type="button" onClick={createSubfolder} disabled={busy}>
                Create a “Mindex Catalogue” folder inside it
              </button>
              <button type="button" className="ghost" onClick={() => setForeign(null)} disabled={busy}>
                Pick somewhere else
              </button>
            </div>
          </div>
        )}

        {!foreign && (
          <button type="button" className="primary" onClick={choose} disabled={busy}>
            Choose folder…
          </button>
        )}

        {state.recent.length > 0 && (
          <section className="recent">
            <h2>Recent</h2>
            <ul>
              {state.recent.map((path) => (
                <li key={path}>
                  <button type="button" className="link" onClick={() => openRecent(path)} disabled={busy}>
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
