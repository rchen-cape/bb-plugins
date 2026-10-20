import { useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import type { SendResult } from "../contract";
import { captionFor } from "../lib/actions.js";
import type { SketchElement } from "../lib/scene.js";
import { LIMITS } from "../lib/sketch.js";
import { CAPTION_LIMIT } from "../lib/selection.js";
import { ErrorText } from "./bits";
import { useLoaded, useSketchRpc } from "./hooks";
import { readWikiChoice, writeWikiChoice } from "./storage";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { isModEnter } from "./ui/shortcut";
import { Textarea } from "./ui/textarea";
import { PreviewImage, SendFooter, type KindVia } from "./SendParts";
import { WhereSection } from "./SendWhere";
import { useSendPreview } from "./use-send-preview";
import { useSendRequest } from "./use-send-request";
import { useWikiDestination } from "./use-wiki-destination";
import { useWikiSuggestions } from "./use-wiki-suggestions";
import { effectiveKind, rememberedChoice, sendLabel, suggestText, wikiStatus, type Kind } from "./wiki-destination";
import { wikiCardHref, wikiDocHref } from "./wiki-docs";

export type SendTarget = { readonly elements: readonly SketchElement[]; readonly title: string; readonly selection: boolean };

function toastResult(result: SendResult, openWiki: (href: string) => void): void {
  if (result.kind === "inbox") {
    toast.success("Sent to your Wiki inbox", { action: { label: "Review", onClick: () => openWiki(wikiCardHref(result.cardId)) } });
    return;
  }
  toast.success(`Added to ${result.title}`, { action: { label: "Open", onClick: () => openWiki(wikiDocHref(result.slug)) } });
}

function MessageFields({ caption, note, onCaption, onNote }: { caption: string; note: string; onCaption: (value: string) => void; onNote: (value: string) => void }) {
  return (
    <>
      <Field label="Caption" hint={`${[...caption].length}/${CAPTION_LIMIT}`}>
        <Input value={caption} maxLength={CAPTION_LIMIT} placeholder="Describe the sketch (optional)" onChange={(event) => onCaption(event.target.value)} />
      </Field>
      <Field label="Add a note">
        <Textarea
          value={note}
          maxLength={LIMITS.note}
          placeholder="Optional Markdown above the image"
          rows={2}
          className="min-h-14 resize-y text-sm"
          onChange={(event) => onNote(event.target.value)}
        />
      </Field>
    </>
  );
}

function SendHeader({ target }: { target: SendTarget }) {
  return (
    <DialogHeader>
      <DialogTitle>Send to Wiki</DialogTitle>
      <DialogDescription>
        {target.selection ? "Sends the selected part of “" : "Sends all of “"}
        {target.title}” as a PNG image.
      </DialogDescription>
    </DialogHeader>
  );
}

function useSendForm(target: SendTarget) {
  const rpc = useSketchRpc();
  const [stored] = useState(readWikiChoice);
  const [chosenKind, setKind] = useState<Kind>(stored.kind);
  const [focusSearch, setFocusSearch] = useState(stored.kind === "doc");
  const [caption, setCaption] = useState(() => captionFor(target.elements));
  const [note, setNote] = useState("");
  const wiki = useLoaded(() => rpc.call("wikiDocs", {}), [rpc]);
  const status = wikiStatus(wiki);
  const suggestions = useWikiSuggestions(suggestText(caption, note), target.title);
  const destination = useWikiDestination({ docs: status.kind === "ready" ? status.docs : undefined, docsSettled: status.kind !== "loading", stored, suggestions });
  const searchRef = useRef<HTMLInputElement>(null);
  const chooseKind = (kind: Kind, via: KindVia) => {
    const focus = kind === "doc" && via === "click";
    setKind(kind);
    setFocusSearch(focus);
    if (focus) searchRef.current?.focus();
  };
  return { rpc, stored, kind: effectiveKind(chosenKind, status), chooseKind, focusSearch, searchRef, caption, setCaption, note, setNote, status, suggestions, destination };
}

export function SendToWikiDialog({ target, onClose, openWiki }: { target: SendTarget; onClose: () => void; openWiki: (href: string) => void }) {
  const form = useSendForm(target);
  const preview = useSendPreview(target.elements);
  const request = useSendRequest();
  const where = form.destination.destination(form.kind);
  const canSend = preview.status === "ready" && form.status.kind === "ready" && !request.busy && where !== null;

  const submit = () => {
    if (!canSend || where === null || preview.status !== "ready") return;
    const input = { name: target.title, png: preview.base64, caption: form.caption.trim(), note: form.note.trim(), destination: where };
    void request.run(async () => {
      const result = await form.rpc.call("sendToWiki", input);
      writeWikiChoice(rememberedChoice(where, form.stored));
      onClose();
      toastResult(result, openWiki);
    });
  };
  const requestClose = () => {
    if (!request.busy) onClose();
  };
  const holdWhileBusy = (event: Event) => {
    if (request.busy) event.preventDefault();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isModEnter(event)) return;
    event.preventDefault();
    submit();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : requestClose())}>
      <DialogContent
        className="max-h-[90dvh] min-h-0 max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
        hideCloseButton={request.busy}
        onEscapeKeyDown={holdWhileBusy}
        onInteractOutside={holdWhileBusy}
        onKeyDown={onKeyDown}
      >
        <SendHeader target={target} />
        <div data-send-body="" className="-mx-1 grid min-h-0 content-start gap-3.5 overflow-y-auto px-1 pb-1">
          <PreviewImage preview={preview} />
          <MessageFields caption={form.caption} note={form.note} onCaption={form.setCaption} onNote={form.setNote} />
          <WhereSection
            kind={form.kind}
            status={form.status}
            destination={form.destination}
            suggestions={form.suggestions.list}
            focusSearch={form.focusSearch}
            searchRef={form.searchRef}
            onKind={form.chooseKind}
          />
          {request.error === null ? null : <ErrorText>{request.error}</ErrorText>}
        </div>
        <SendFooter label={sendLabel(form.kind, form.destination.choice, request.busy)} canSend={canSend} busy={request.busy} onCancel={requestClose} onSend={submit} />
      </DialogContent>
    </Dialog>
  );
}
