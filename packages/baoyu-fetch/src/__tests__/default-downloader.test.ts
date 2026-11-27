import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadMediaAssets } from "../media/default-downloader";
import { resolveMediaKind } from "../media/media-utils";
import type { Logger } from "../utils/logger";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function createTestLogger(): { log: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    log: {
      debug() {},
      info() {},
      warn(message: string) {
        warnings.push(message);
      },
      error() {},
    },
  };
}

async function createTempOutputPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baoyu-fetch-dl-"));
  tempDirs.push(dir);
  return path.join(dir, "article.md");
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("downloadMediaAssets security and content-type checks", () => {
  test("rejects non-HTTPS media URLs without calling fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const outputPath = await createTempOutputPath();
    const { log, warnings } = createTestLogger();

    const result = await downloadMediaAssets({
      media: [{ url: "http://example.com/photo.png", kind: "image", role: "inline" }],
      outputPath,
      log,
    });

    expect(called).toBe(false);
    expect(result.downloadedImages).toBe(0);
    expect(result.replacements).toEqual([]);
    expect(warnings.some((w) => w.includes("Only HTTPS media downloads are allowed"))).toBe(true);
  });

  test("rejects HTTPS-to-HTTP redirect downgrades", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requestedUrls.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: "http://insecure.example.com/photo.png" },
      });
    }) as unknown as typeof fetch;

    const outputPath = await createTempOutputPath();
    const { log, warnings } = createTestLogger();

    const result = await downloadMediaAssets({
      media: [{ url: "https://example.com/photo.png", kind: "image", role: "inline" }],
      outputPath,
      log,
    });

    expect(requestedUrls).toEqual(["https://example.com/photo.png"]);
    expect(result.downloadedImages).toBe(0);
    expect(warnings.some((w) => w.includes("Only HTTPS media downloads are allowed"))).toBe(true);
  });

  test("follows up to 5 HTTPS redirects and rejects a 6th redirect", async () => {
    const outputPath = await createTempOutputPath();
    const { log, warnings } = createTestLogger();

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeDefined();
      const hop = Number(new URL(url).searchParams.get("hop") ?? "0");
      if (hop < 5) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://cdn.example.com/img.png?hop=${hop + 1}` },
        });
      }
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const okResult = await downloadMediaAssets({
      media: [{ url: "https://cdn.example.com/img.png?hop=0", kind: "image", role: "inline" }],
      outputPath,
      log,
    });

    expect(okResult.downloadedImages).toBe(1);
    const saved = await readFile(okResult.replacements[0]!.absolutePath);
    expect(Array.from(saved)).toEqual([137, 80, 78, 71]);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const hop = Number(new URL(url).searchParams.get("hop") ?? "0");
      return new Response(null, {
        status: 302,
        headers: { location: `https://cdn.example.com/img.png?hop=${hop + 1}` },
      });
    }) as unknown as typeof fetch;

    const tooManyResult = await downloadMediaAssets({
      media: [{ url: "https://cdn.example.com/img.png?hop=0", kind: "image", role: "inline" }],
      outputPath,
      log,
    });

    expect(tooManyResult.downloadedImages).toBe(0);
    expect(warnings.some((w) => w.includes("Too many redirects (max 5)"))).toBe(true);
  });

  test("strips Authorization and Cookie headers across cross-origin redirects", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenHeaders.push({ ...(init?.headers as Record<string, string>) });
      if (url.startsWith("https://origin-a.example.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://origin-b.example.com/final.png" },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const outputPath = await createTempOutputPath();
    const { log } = createTestLogger();

    const result = await downloadMediaAssets({
      media: [
        {
          url: "https://origin-a.example.com/start.png",
          kind: "image",
          role: "inline",
          headers: { Authorization: "Bearer secret", Cookie: "sid=1", Referer: "https://origin-a.example.com/" },
        },
      ],
      outputPath,
      log,
    });

    expect(result.downloadedImages).toBe(1);
    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders[0]?.Authorization).toBe("Bearer secret");
    expect(seenHeaders[0]?.Cookie).toBe("sid=1");
    expect(seenHeaders[1]?.Authorization).toBeUndefined();
    expect(seenHeaders[1]?.Cookie).toBeUndefined();
    expect(seenHeaders[1]?.Referer).toBe("https://origin-a.example.com/");
  });

  test("rejects HTML error pages even when URL has an image extension", async () => {
    globalThis.fetch = (async () => {
      return new Response("<html><body>Login required</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    const outputPath = await createTempOutputPath();
    const { log, warnings } = createTestLogger();

    const result = await downloadMediaAssets({
      media: [{ url: "https://example.com/expired-image.png", kind: "image", role: "inline" }],
      outputPath,
      log,
    });

    expect(result.downloadedImages).toBe(0);
    expect(result.replacements).toEqual([]);
    expect(warnings.some((w) => w.includes("unsupported content-type (text/html)"))).toBe(true);
    expect(resolveMediaKind("https://example.com/a.png", "application/octet-stream", "png")).toBe("image");
    expect(resolveMediaKind("https://example.com/a.png", "text/html", "png", "image")).toBeUndefined();
  });
});
