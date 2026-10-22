import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { lspConnection } from "./gopls";

function frame(message: object): string {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function connected() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const sent: Array<{ id?: number; method?: string; result?: unknown }> = [];
  toServer.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    sent.push(JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)));
  });
  return { connection: lspConnection(toServer, fromServer), fromServer, sent };
}

describe("lspConnection", () => {
  it("matches answers to requests, even when a message arrives in pieces", async () => {
    const { connection, fromServer, sent } = connected();
    const answer = connection.request("textDocument/definition", {});
    expect(sent[0]).toMatchObject({ id: 1, method: "textDocument/definition" });
    const raw = frame({ id: 1, result: [{ uri: "file:///a/é.go", range: { start: { line: 3 } } }] });
    fromServer.write(raw.slice(0, 10));
    fromServer.write(raw.slice(10));
    await expect(answer).resolves.toEqual([{ uri: "file:///a/é.go", range: { start: { line: 3 } } }]);
  });

  it("answers the server's own requests so it never waits on us", async () => {
    const { fromServer, sent } = connected();
    fromServer.write(frame({ id: 9, method: "workspace/configuration", params: { items: [{}, {}] } }) + frame({ id: 10, method: "window/workDoneProgress/create" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 9, result: [null, null] },
      { jsonrpc: "2.0", id: 10, result: null },
    ]);
  });

  it("rejects on an error answer and after the server goes away", async () => {
    const { connection, fromServer } = connected();
    const failing = connection.request("textDocument/definition", {});
    fromServer.write(frame({ id: 1, error: { message: "no package" } }));
    await expect(failing).rejects.toThrow("no package");
    const pending = connection.request("textDocument/definition", {});
    connection.close(new Error("gopls exited"));
    await expect(pending).rejects.toThrow("gopls exited");
    await expect(connection.request("initialize", {})).rejects.toThrow("gopls exited");
  });
});
