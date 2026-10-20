import { rpcContract } from "../contract.js";
import type { SketchContext } from "./context.js";
import { friendly } from "./errors.js";
import { decodePng } from "./previews.js";
import { statusOf, wikiDocsOf } from "./status.js";
import { targetOf } from "./wiki.js";

export function registerRpc(ctx: SketchContext): void {
  const { store, wiki } = ctx;
  ctx.bb.rpc.register(rpcContract, {
    status: friendly(() => statusOf(ctx)),
    list: friendly(() => store.list()),
    get: friendly(({ id }) => store.get(id)),
    create: friendly(({ title, content }) => store.create(title, content)),
    save: friendly(({ id, content, expectedSha256 }) => store.save(id, content, expectedSha256)),
    rename: friendly(({ id, title }) => store.rename(id, title)),
    duplicate: friendly(({ id }) => store.duplicate(id)),
    delete: friendly(({ id }) => store.remove(id)),
    savePreview: friendly(({ id, sha256, png }) => store.savePreview(id, sha256, decodePng(png))),
    wikiDocs: friendly(() => wikiDocsOf(ctx)),
    wikiSuggest: friendly(async ({ text, title }) => ({ suggestions: await wiki.suggest(text, title) })),
    sendToWiki: friendly(({ name, png, caption, note, destination }) =>
      wiki.send({ name, png: decodePng(png), caption, note, target: targetOf(destination), threadId: null }),
    ),
  });
}
