import { afterEach, describe, expect, test } from "bun:test";
import { WebSocketServer } from "ws";
import { CdpClient } from "../browser/cdp-client";

const servers: WebSocketServer[] = [];

async function startWsServer(): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test WebSocket server");
  }
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

describe("CdpClient connection resilience", () => {
  test("rejects pending commands immediately when the WebSocket closes", async () => {
    const { server, url } = await startWsServer();
    server.on("connection", (socket) => {
      socket.once("message", () => {
        socket.close(1011, "browser crashed");
      });
    });

    const client = await CdpClient.connect(url);
    await expect(client.sendBrowserCommand("Browser.getVersion")).rejects.toThrow(
      /Browser\.getVersion: CDP WebSocket closed/,
    );
    await expect(client.sendBrowserCommand("Browser.getVersion")).rejects.toThrow(
      /CDP WebSocket is not open/,
    );
  });

  test("ignores malformed non-JSON messages without crashing and still resolves valid responses", async () => {
    const { server, url } = await startWsServer();
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const req = JSON.parse(raw.toString()) as { id: number };
        socket.send("not-json");
        socket.send(JSON.stringify({ id: req.id, result: { ok: true } }));
      });
    });

    const client = await CdpClient.connect(url);
    try {
      const result = await client.sendBrowserCommand<{ ok: boolean }>("Browser.getVersion");
      expect(result).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });
});
