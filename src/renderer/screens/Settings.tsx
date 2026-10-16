/**
 * Settings, and the "verify library" report.
 *
 * Everything here is about the folder rather than the app: where it is, how
 * SQLite is journalling to it, and whether what is on disk still matches what
 * the database believes.
 */

import { CircleCheck, FolderInput, FolderOpen, ScanSearch } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { JournalMode, LibraryState, VerifyReport } from '@shared/types';
import { api } from '../state/api.js';
import { fileSize } from '../components/format.js';
import { Badge, Banner, Button, Pane, RadioGroup, RadioItem } from '../components/ui/index.js';

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
    report !== null &&
    report.orphanFolders.length === 0 &&
    report.missingFolders.length === 0 &&
    report.missingFiles.length === 0 &&
    report.untrackedFiles.length === 0 &&
    report.conflictedCopies.length === 0;

  return (
    <Pane>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-8 p-4">
          {error && <Banner tone="danger">{error}</Banner>}

          <Group title="Library">
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2.5">
              <dt className="text-text-muted">Folder</dt>
              <dd className="min-w-0 break-all">
                <code>{state.path}</code>
              </dd>
              <dt className="text-text-muted">Storage</dt>
              <dd>
                <Badge>{STORAGE_LABELS[state.storageKind ?? 'local'] ?? state.storageKind}</Badge>
              </dd>
              <dt className="text-text-muted">Schema</dt>
              <dd>
                {state.schema}
                {state.appSchema !== undefined && state.appSchema !== state.schema && (
                  <span className="text-text-muted"> (this app understands {state.appSchema})</span>
                )}
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button icon={FolderInput} onClick={() => void changeLibrary()}>
                Change library…
              </Button>
              <Button variant="ghost" icon={FolderOpen} onClick={() => void api.library.reveal()}>
                Open folder in file manager
              </Button>
            </div>
          </Group>

          <Group title="Journal mode">
            <p className="text-text-muted">
              WAL is faster and lets reading carry on while another machine writes, but it needs a shared-memory file
              that network shares and sync clients do not provide. Mindex picks the safe option automatically; change
              it only if you know the folder better than the guess does.
            </p>
            <RadioGroup
              aria-label="Journal mode"
              value={state.journalMode ?? ''}
              onValueChange={(value) => {
                if (value === 'wal' || value === 'truncate') void setMode(value);
              }}
            >
              <RadioItem value="wal" label="WAL — local disks" />
              <RadioItem value="truncate" label="Rollback journal — network and sync folders" />
            </RadioGroup>
          </Group>

          {state.readOnly && (
            <Banner tone="warning">
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text">Read-only</h3>
                <p>{state.readOnlyReason}</p>
                <div>
                  <Button onClick={() => void api.library.takeOverLock()}>Take over anyway</Button>
                </div>
              </div>
            </Banner>
          )}

          <Group title="Verify library">
            <p className="text-text-muted">
              Compares the database against the folder. It changes nothing — it just tells you what has drifted, so
              you can fix it yourself.
            </p>
            <div>
              <Button icon={ScanSearch} onClick={() => void verify()} disabled={busy}>
                {busy ? 'Checking…' : 'Check now'}
              </Button>
            </div>

            {report && (
              <div className="flex flex-col gap-3">
                {healthy ? (
                  <p data-testid="verify-ok" className="flex items-center gap-2">
                    <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-ok" />
                    Everything matches.
                  </p>
                ) : (
                  <Banner tone="warning">
                    <div className="flex flex-col gap-1.5">
                      <ReportRow label="Folders with no item" items={report.orphanFolders} />
                      <ReportRow label="Item folders missing" items={report.missingFolders} />
                      <ReportRow
                        label="Files the database expected"
                        items={report.missingFiles.map((f) => f.filename)}
                      />
                      <ReportRow
                        label="Files not in the database"
                        items={report.untrackedFiles.map((f) => f.filename)}
                      />
                      <ReportRow label="Sync conflict copies" items={report.conflictedCopies} />
                    </div>
                  </Banner>
                )}
                <p className="text-sm text-text-muted">
                  Trash holds {fileSize(report.trashSizeBytes)}.{' '}
                  <Button variant="link" onClick={() => void api.library.reveal()}>
                    Open the folder
                  </Button>{' '}
                  if you want to prune it.
                </p>
              </div>
            )}
          </Group>

          {version && (
            <Group title="About">
              <p className="text-text-muted">
                Mindex {version.version} · Electron {version.electron} · schema {version.schema}
              </p>
            </Group>
          )}
        </div>
      </div>
    </Pane>
  );
}

/** A titled block of settings. The heading names the region, so a screen reader can jump between groups. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-sm font-semibold text-text">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ReportRow({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <p>
      <strong className="font-semibold">
        {label} ({items.length}):
      </strong>{' '}
      <span className="text-text-muted">
        {items.slice(0, 8).join(', ')}
        {items.length > 8 ? ', …' : ''}
      </span>
    </p>
  );
}
