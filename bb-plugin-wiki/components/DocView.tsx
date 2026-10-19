import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Markdown, experimental_copyToClipboard, experimental_usePluginId, useBbNavigate, useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import type { Backlink, DocDetail, DocSummary } from "../contract";
import { WIKI_PANEL } from "../lib/wiki";
import { EmptyState, ErrorText, TagChip, TypeBadge, formatDate } from "./bits";
import { useDocActions } from "./DocActions";
import { DocEditor } from "./DocEditor";
import { createResolver, parseThreadHref, parseWikiHref, renderDoc, renderedHeadingIndex } from "./doc-render";
import { errorMessage, useDoc } from "./hooks";
import { docSubPath } from "./nav";

const ANCHOR_WAIT_MS = 3_000;

interface DocViewProps {
  slug: string;
  anchor: string | null;
  docs: readonly DocSummary[] | undefined;
  wikiDirectory: string | null;
  onBack?: () => void;
}

export function DocView({ slug, anchor, docs, wikiDirectory, onBack }: DocViewProps) {
  const { doc, error } = useDoc(slug);
  const [editing, setEditing] = useState<DocDetail | null>(null);
  const editorDoc = editing === null ? null : (doc ?? editing);

  let content;
  if (editorDoc !== null) {
    content = <DocEditor doc={editorDoc} onClose={() => setEditing(null)} />;
  } else if (doc === null) {
    content = <EmptyState title="This doc isn't in the Wiki" description={`Nothing is saved at “${slug}”. It may have been renamed or deleted.`} />;
  } else if (doc === undefined || docs === undefined) {
    content = error === null ? <p className="text-sm text-muted-foreground">Loading…</p> : <ErrorText>{error}</ErrorText>;
  } else {
    content = <DocReader doc={doc} anchor={anchor} docs={docs} wikiDirectory={wikiDirectory} onEdit={() => setEditing(doc)} />;
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

function useWikiLinkClicks(container: RefObject<HTMLDivElement | null>) {
  const navigate = useBbNavigate();
  useEffect(() => {
    const node = container.current;
    if (node === null) return;
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      const href = link?.getAttribute("href") ?? "";
      const wiki = parseWikiHref(href);
      const threadId = wiki === null ? parseThreadHref(href) : null;
      if (wiki === null && threadId === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (wiki !== null) navigate.toPluginPanel(WIKI_PANEL, { subPath: docSubPath(wiki.slug, wiki.anchor) });
      else if (threadId !== null) navigate.toThread(threadId);
    };
    node.addEventListener("click", onClick, true);
    return () => node.removeEventListener("click", onClick, true);
  }, [container, navigate]);
}

function findHeading(container: HTMLElement, content: string, anchor: string, title: string): Element | undefined {
  const headings = [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  return headings[renderedHeadingIndex(content, anchor, headings.map((heading) => heading.textContent ?? ""), title)];
}

interface AnchorTarget {
  slug: string;
  title: string;
  content: string;
}

function useScrollToAnchor(container: RefObject<HTMLDivElement | null>, anchor: string | null, { slug, title, content }: AnchorTarget) {
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    const node = container.current;
    if (anchor === null) {
      scrolledTo.current = null;
      return;
    }
    const key = `${slug}#${anchor}`;
    if (node === null || scrolledTo.current === key) return;
    const scroll = () => {
      const heading = findHeading(node, content, anchor, title);
      if (heading === undefined) return false;
      heading.scrollIntoView?.({ block: "start" });
      scrolledTo.current = key;
      return true;
    };
    if (scroll()) return;
    const observer = new MutationObserver(() => {
      if (scroll()) observer.disconnect();
    });
    observer.observe(node, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), ANCHOR_WAIT_MS);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [container, anchor, slug, content, title]);
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

function useOpenFile(wikiDirectory: string | null, slug: string) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const filePath = wikiDirectory !== null && wikiDirectory.startsWith("/") ? joinPath(wikiDirectory, `${slug}.md`) : null;
  if (filePath === null || typeof navigate.experimental_openFileExternally !== "function") return null;
  return async () => {
    try {
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

interface DocReaderProps {
  doc: DocDetail;
  anchor: string | null;
  docs: readonly DocSummary[];
  wikiDirectory: string | null;
  onEdit: () => void;
}

function DocReader({ doc, anchor, docs, wikiDirectory, onEdit }: DocReaderProps) {
  const pluginId = experimental_usePluginId();
  const resolve = useMemo(() => createResolver(docs), [docs]);
  const rendered = useMemo(
    () => renderDoc(doc.content, { pluginId, resolve, docSlug: doc.slug, title: doc.title }),
    [doc.content, doc.slug, doc.title, pluginId, resolve],
  );
  const body = useRef<HTMLDivElement>(null);
  const openFile = useOpenFile(wikiDirectory, doc.slug);
  const actions = useDocActions();
  useWikiLinkClicks(body);
  useScrollToAnchor(body, anchor, doc);

  const copyLink = async () => {
    const link = `[[${doc.title}]]`;
    const copied = await experimental_copyToClipboard({ text: link });
    if (copied) toast.success(`Copied ${link}`);
    else toast.error("Couldn't copy to the clipboard.");
  };

  return (
    <article>
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
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Icon name="Edit" />
            Edit
          </Button>
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
        </div>
      </header>
      <div
        ref={body}
        className="mt-4 border-t border-border pt-4 [&_span[title]]:cursor-help [&_span[title]]:underline [&_span[title]]:decoration-dotted [&_span[title]]:underline-offset-4 [&_sub]:text-xs [&_sub]:text-muted-foreground [&_video]:max-w-full [&_video]:rounded-md"
      >
        {rendered.trim() === "" ? (
          <EmptyState
            title="This doc is empty"
            action={
              <Button size="sm" onClick={onEdit}>
                Edit
              </Button>
            }
          />
        ) : (
          <Markdown content={rendered} />
        )}
      </div>
      <BacklinkList backlinks={doc.backlinks} />
    </article>
  );
}
