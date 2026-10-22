import { useEffect, useState, type KeyboardEvent } from "react";
import { experimental_copyToClipboard, useBbNavigate, useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import type { Backlink, DocDetail, DocSummary } from "../contract";
import { WIKI_PANEL } from "../lib/wiki";
import { EmptyState, ErrorText, TagChip, TypeBadge, formatDate } from "./bits";
import { useDocActions } from "./DocActions";
import { errorMessage, useDoc } from "./hooks";
import { docSubPath } from "./nav";
import { useLiveDoc, type ConflictKind, type LiveDoc, type SaveStatus } from "./use-live-doc";

interface DocViewProps {
  slug: string;
  anchor: string | null;
  docs: readonly DocSummary[] | undefined;
  wikiDirectory: string | null;
  onBack?: () => void;
}

const STATUS_LABELS: Record<SaveStatus, string | null> = {
  idle: null,
  saving: "Saving…",
  saved: "Saved",
  dirty: "Unsaved changes",
  error: "Couldn't save",
};

function isSaveShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s";
}

export function DocView({ slug, anchor, docs, wikiDirectory, onBack }: DocViewProps) {
  const { doc, error } = useDoc(slug);
  const [raw, setRaw] = useState(false);
  const live = useLiveDoc({ slug, doc, docs, anchor, raw });
  const actions = useDocActions();
  const { flush, discard } = live;

  useEffect(() => actions?.registerDoc(slug, { flush, discard }), [actions, slug, flush, discard]);

  let content;
  if (live.shown === null || live.gone) {
    content =
      doc === null || live.gone ? (
        <EmptyState title="This doc isn't in the Wiki" description={`Nothing is saved at “${slug}”. It may have been renamed or deleted.`} />
      ) : error === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ErrorText>{error}</ErrorText>
      );
  } else if (docs === undefined) {
    content = error === null ? <p className="text-sm text-muted-foreground">Loading…</p> : <ErrorText>{error}</ErrorText>;
  } else {
    content = <DocBody doc={live.shown} live={live} raw={raw} onToggleRaw={() => setRaw((current) => !current)} wikiDirectory={wikiDirectory} />;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-10 pt-3 md:px-6 md:pt-4">
      {onBack === undefined ? null : (
        <Button variant="ghost" size="sm" className="-ml-2 mb-2 text-muted-foreground" onClick={onBack}>
          <Icon name="ArrowLeft" />
          Wiki
        </Button>
      )}
      {content}
    </div>
  );
}

function joinPath(directory: string, relative: string): string {
  return `${directory.replace(/\/+$/, "")}/${relative}`;
}

async function primaryHostId(sdk: PluginBrowserBbSdk): Promise<string | null> {
  try {
    return (await sdk.system.config()).primaryHostId;
  } catch {
    return null;
  }
}

async function serverHostId(sdk: PluginBrowserBbSdk): Promise<string> {
  const primary = await primaryHostId(sdk);
  if (primary !== null) return primary;
  const hosts = await sdk.hosts.list({ type: "persistent" });
  const host = hosts.find((candidate) => candidate.status === "connected") ?? hosts[0];
  if (host === undefined) throw new Error("No machine is connected to bb.");
  return host.id;
}

function useOpenFile(wikiDirectory: string | null, slug: string, flush: () => Promise<boolean>) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const filePath = wikiDirectory !== null && wikiDirectory.startsWith("/") ? joinPath(wikiDirectory, `${slug}.md`) : null;
  if (filePath === null || typeof navigate.experimental_openFileExternally !== "function") return null;
  return async () => {
    try {
      await flush();
      const hostId = await serverHostId(sdk);
      const opened = navigate.experimental_openFileExternally({ target: { kind: "host", hostId, path: filePath }, location: null });
      if (!opened) toast.error("Couldn't open the file.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
}

function BacklinkList({ backlinks }: { backlinks: readonly Backlink[] }) {
  const navigate = useBbNavigate();
  if (backlinks.length === 0) return null;
  return (
    <nav aria-labelledby="wiki-backlinks" className="mt-8 border-t border-border pt-4">
      <h2 id="wiki-backlinks" className="text-xs font-medium text-muted-foreground">
        Linked from
      </h2>
      <ul className="mt-2 flex flex-col gap-1">
        {backlinks.map((link) => (
          <li key={`${link.slug}#${link.heading}`}>
            <button
              type="button"
              className="cursor-pointer text-left text-sm text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => navigate.toPluginPanel(WIKI_PANEL, { subPath: docSubPath(link.slug) })}
            >
              {link.title}
              {link.heading === "" ? null : <span className="text-muted-foreground"> › {link.heading}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ConflictBanner({ kind, busy, onReload, onOverwrite, onDiscard }: { kind: ConflictKind; busy: boolean; onReload: () => void; onOverwrite: () => void; onDiscard: () => void }) {
  return (
    <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-attention px-3 py-2 text-sm">
      {kind === "changed" ? (
        <span className="min-w-0 flex-1 text-foreground">
          Changed on disk. <span className="text-muted-foreground">Reload to see the new version, or overwrite it with your edits.</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 text-foreground">
          Deleted on disk. <span className="text-muted-foreground">Overwrite to save it again with your edits, or discard them.</span>
        </span>
      )}
      {kind === "changed" ? (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onReload}>
          Reload
        </Button>
      ) : (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
          Discard
        </Button>
      )}
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onOverwrite}>
        Overwrite
      </Button>
    </div>
  );
}

interface DocBodyProps {
  doc: DocDetail;
  live: LiveDoc;
  raw: boolean;
  onToggleRaw: () => void;
  wikiDirectory: string | null;
}

function DocBody({ doc, live, raw, onToggleRaw, wikiDirectory }: DocBodyProps) {
  const openFile = useOpenFile(wikiDirectory, doc.slug, live.flush);
  const actions = useDocActions();
  const status = STATUS_LABELS[live.status];

  const copyLink = async () => {
    const link = `[[${doc.title}]]`;
    const copied = await experimental_copyToClipboard({ text: link });
    if (copied) toast.success(`Copied ${link}`);
    else toast.error("Couldn't copy to the clipboard.");
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isSaveShortcut(event)) return;
    event.preventDefault();
    void live.flush();
  };

  return (
    <article onKeyDown={onKeyDown}>
      <header className="space-y-3">
        <h1 className="text-xl font-semibold leading-tight text-foreground">{doc.title}</h1>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <TypeBadge type={doc.type} />
          <span title="Type this tag in a daily note to send the note here">
            <TagChip tag={doc.tag} active />
          </span>
          {doc.aliases.map((alias) => (
            <TagChip key={alias} tag={alias} />
          ))}
          <span className="ml-1" title={new Date(doc.updatedAt).toLocaleString()}>
            Updated {formatDate(doc.updatedAt)}
          </span>
          <span role="status" aria-live="polite" className={live.status === "error" ? "text-destructive" : "text-subtle-foreground"} title={live.statusDetail ?? undefined}>
            {status === null ? null : `· ${status}`}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void copyLink()}>
            <Icon name="Link" />
            Copy link
          </Button>
          {openFile === null ? null : (
            <Button size="sm" variant="ghost" onClick={() => void openFile()}>
              <Icon name="ExternalLink" />
              Open file
            </Button>
          )}
          {actions === null ? null : (
            <>
              <Button size="sm" variant="ghost" onClick={() => actions.rename(doc)}>
                <Icon name="Edit" />
                Rename
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => actions.remove(doc)}>
                <Icon name="Trash" />
                Delete
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" aria-pressed={raw} onClick={onToggleRaw}>
            <Icon name="Code" />
            Markdown
          </Button>
        </div>
      </header>
      {live.conflict === null ? null : (
        <ConflictBanner kind={live.conflict} busy={live.busy} onReload={() => void live.reload()} onOverwrite={() => void live.overwrite()} onDiscard={live.discard} />
      )}
      {live.error === null ? null : <ErrorText className="mt-2">{live.error}</ErrorText>}
      <div ref={live.container} className="mt-4 border-t border-border pt-4" />
      <BacklinkList backlinks={doc.backlinks} />
    </article>
  );
}
