import { useEffect } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { WIKI_PANEL } from "../lib/wiki";
import { channel } from "./requests";

export type WikiRoute =
  | { kind: "home" }
  | { kind: "doc"; slug: string; anchor: string | null }
  | { kind: "inbox"; cardId: string | null }
  | { kind: "search"; query: string }
  | { kind: "new" };

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function decodeSubPath(subPath: string): string {
  return subPath.split("/").map(safeDecode).join("/");
}

function parseDoc(rest: string): WikiRoute {
  const hash = rest.lastIndexOf("#");
  const slug = trimSlashes(hash === -1 ? rest : rest.slice(0, hash));
  if (slug === "") return { kind: "home" };
  const anchor = hash === -1 ? "" : rest.slice(hash + 1);
  return { kind: "doc", slug, anchor: anchor === "" ? null : anchor };
}

function parseSearch(rest: string): WikiRoute {
  const question = rest.indexOf("?");
  const query = question === -1 ? "" : (new URLSearchParams(rest.slice(question + 1)).get("q") ?? "");
  return { kind: "search", query };
}

export function parseRoute(subPath: string): WikiRoute {
  const path = trimSlashes(decodeSubPath(subPath));
  if (path.startsWith("doc/")) return parseDoc(path.slice("doc/".length));
  if (path === "inbox") return { kind: "inbox", cardId: null };
  if (path.startsWith("inbox/")) {
    const cardId = trimSlashes(path.slice("inbox/".length));
    return { kind: "inbox", cardId: cardId === "" ? null : cardId };
  }
  if (path === "search" || path.startsWith("search?")) return parseSearch(path);
  if (path === "new") return { kind: "new" };
  return { kind: "home" };
}

export function docSubPath(slug: string, anchor: string | null = null): string {
  return anchor === null || anchor === "" ? `doc/${slug}` : `doc/${slug}#${anchor}`;
}

export function inboxSubPath(cardId: string | null = null): string {
  return cardId === null ? "inbox" : `inbox/${cardId}`;
}

export function searchSubPath(query: string): string {
  return query.trim() === "" ? "search" : `search?${new URLSearchParams({ q: query }).toString()}`;
}

export const navRequests = channel<string>();

export function WikiNavBridge() {
  const navigate = useBbNavigate();
  useEffect(() => navRequests.subscribe((subPath) => navigate.toPluginPanel(WIKI_PANEL, subPath === "" ? undefined : { subPath })), [navigate]);
  return null;
}
