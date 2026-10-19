import { definePluginApp, type PluginMessageActionContext } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { WIKI_ICON, WikiBookOpenIcon } from "./components/bits";
import { CodeFenceWithWikiButton, WIKI_CODE_LANGUAGES } from "./components/CodeFence";
import { inboxSubPath, navRequests, WikiNavBridge } from "./components/nav";
import { addRequests, searchRequests } from "./components/requests";
import { WikiOverlay } from "./components/WikiOverlay";
import { WikiPage } from "./components/WikiPage";
import { WIKI_PANEL } from "./lib/wiki";

const STILL_LOADING = "The Wiki is still loading. Try again in a moment.";

export function addMessageToWiki({ threadId, message, selectedText }: PluginMessageActionContext): void {
  const text = (selectedText ?? message.text).trim();
  if (text === "") {
    toast.error("This message has no text to add.");
    return;
  }
  const delivered = addRequests.emit({
    kind: "message",
    threadId,
    messageId: message.id,
    messageSeq: message.experimental_messageSeq ?? null,
    text,
    fromSelection: selectedText !== undefined,
  });
  if (!delivered) toast.error(STILL_LOADING);
}

function openWiki(subPath: string): void {
  if (!navRequests.emit(subPath)) toast.error(STILL_LOADING);
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: WIKI_ICON, component: WikiBookOpenIcon });
  app.slots.navPanel({
    id: WIKI_PANEL,
    title: "Wiki",
    icon: WIKI_ICON,
    path: WIKI_PANEL,
    component: WikiPage,
  });
  app.slots.experimental_appOverlay({ id: "wiki-overlay", component: WikiOverlay });
  app.slots.experimental_appOverlay({ id: "wiki-nav", component: WikiNavBridge });
  app.slots.messageAction({ id: "add", title: "Add to Wiki", icon: WIKI_ICON, run: addMessageToWiki });
  app.slots.experimental_codeFenceRenderer({ id: "wiki-code", languages: WIKI_CODE_LANGUAGES, component: CodeFenceWithWikiButton });
  app.commands.register({
    id: "search",
    title: "Wiki: search",
    defaultShortcut: { key: "k", mod: true, shift: true },
    run: () => {
      if (!searchRequests.emit(null)) toast.error(STILL_LOADING);
    },
  });
  app.commands.register({ id: "open", title: "Wiki: open", run: () => openWiki("") });
  app.commands.register({ id: "inbox", title: "Wiki: review inbox", run: () => openWiki(inboxSubPath()) });
});
