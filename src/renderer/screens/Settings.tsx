/**
 * Settings, and the "verify library" report.
 *
 * Everything here is about the folder rather than the app: where it is, how
 * SQLite is journalling to it, and whether what is on disk still matches what
 * the database believes.
 */

import { useEffect, useState } from 'react';
import type { JournalMode, LibraryState, VerifyReport } from '@shared/types';
import { api } from '../state/api.js';
import { fileSize } from '../components/format.js';

interface Props {
  state: LibraryState;
}

const STORAGE_LABELS: Record<string, string> = {
  local: 'Local disk',
  network: 'Network share',
  sync: 'File-sync folder',
};

export function Settings({ state }: Props) {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [version, setVersion] = useState<{ version: string; electron: string; schema: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.app.getVersion().then(setVersion);
  }, []);

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.library.verify());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changeLibrary = async () => {
    const result = await api.library.choose();
    if (!result.ok && result.error) setError(result.error);
  };

  const setMode = async (mode: JournalMode) => {
    const result = await api.library.setJournalMode(mode);
    if (!result.ok && result.error) setError(result.error);
  };

  const healthy =
    report &&
    report.orphanFolders.length === 0 &&
    report.missingFiles.length === 0 &&
    report.untrackedFiles.length === 0 &&
    report.conflictedCopies.length === 0;

  return (
    <section className="pane">
      <header className="pane-header">
        <h2>Settings</h2>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="settings-group">
        <h3>Library</h3>
        <dl>
          <dt>Folder</dt>
          <dd>
            <code>{state.path}</code>
          </dd>
          <dt>Storage</dt>
          <dd>{STORAGE_LABELS[state.storageKind ?? 'local'] ?? state.storageKind}</dd>
          <dt>Schema</dt>
          <dd>
            {state.schema}
            {state.appSchema !== undefined && state.appSchema !== state.schema && (
              <span className="muted"> (this app understands {state.appSchema})</span>
            )}
          </dd>
        </dl>
        <div className="row">
          <button type="button" onClick={changeLibrary}>
            Change library…
          </button>
          <button type="button" className="ghost" onClick={() => void api.library.reveal()}>
            Open folder in file manager
          </button>
        </div>
      </section>

      <section className="settings-group">
        <h3>Journal mode</h3>
        <p className="muted">
          WAL is faster and lets reading carry on while another machine writes, but it needs a shared-memory
          file that network shares and sync clients do not provide. Mindex picks the safe option
          automatically; change it only if you know the folder better than the guess does.
        </p>
        <div className="row">
          <label className="radio">
            <input
              type="radio"
              name="journal"
              checked={state.journalMode === 'wal'}
              onChange={() => void setMode('wal')}
            />
            WAL — local disks
          </label>
          <label className="radio">
            <input
              type="radio"
              name="journal"
              checked={state.journalMode === 'truncate'}
              onChange={() => void setMode('truncate')}
            />
            Rollback journal — network and sync folders
          </label>
        </div>
      </section>

      {state.readOnly && (
        <section className="settings-group warning-box">
          <h3>Read-only</h3>
          <p>{state.readOnlyReason}</p>
          <button type="button" onClick={() => void api.library.takeOverLock()}>
            Take over anyway
          </button>
        </section>
      )}

      <section className="settings-group">
        <h3>Verify library</h3>
        <p className="muted">
          Compares the database against the folder. It changes nothing — it just tells you what has drifted, so
          you can fix it yourself.
        </p>
        <button type="button" onClick={verify} disabled={busy}>
          {busy ? 'Checking…' : 'Check now'}
        </button>

        {report && (
          <div className="report">
            {healthy && <p className="ok">Everything matches.</p>}
            <ReportRow label="Folders with no item" items={report.orphanFolders} />
            <ReportRow label="Item folders missing" items={report.missingFolders} />
            <ReportRow label="Files the database expected" items={report.missingFiles.map((f) => f.filename)} />
            <ReportRow label="Files not in the database" items={report.untrackedFiles.map((f) => f.filename)} />
            <ReportRow label="Sync conflict copies" items={report.conflictedCopies} />
            <p className="muted">
              Trash holds {fileSize(report.trashSizeBytes)}.{' '}
              <button type="button" className="link" onClick={() => void api.library.reveal()}>
                Open the folder
              </button>{' '}
              if you want to prune it.
            </p>
          </div>
        )}
      </section>

      {version && (
        <section className="settings-group">
          <h3>About</h3>
          <p className="muted">
            Mindex {version.version} · Electron {version.electron} · schema {version.schema}
          </p>
        </section>
      )}
    </section>
  );
}

function ReportRow({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <p>
      <strong>
        {label} ({items.length}):
      </strong>{' '}
      <span className="muted">
        {items.slice(0, 8).join(', ')}
        {items.length > 8 ? ', …' : ''}
      </span>
    </p>
  );
}
