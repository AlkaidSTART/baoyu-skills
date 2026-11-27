import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  downloadFile,
  getImageExtension,
  replaceMarkdownImagesWithPlaceholders,
  resolveContentImages,
  resolveImagePath,
} from "./images.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("replaceMarkdownImagesWithPlaceholders rewrites markdown and tracks image metadata", () => {
  const result = replaceMarkdownImagesWithPlaceholders(
    `![cover](imgs/cover.png)\n\nText\n\n![diagram](imgs/diagram.webp)`,
    "IMG_",
  );

  assert.equal(result.markdown, `IMG_1\n\nText\n\nIMG_2`);
  assert.deepEqual(result.images, [
    { alt: "cover", originalPath: "imgs/cover.png", placeholder: "IMG_1" },
    { alt: "diagram", originalPath: "imgs/diagram.webp", placeholder: "IMG_2" },
  ]);
});

test("image extension and local fallback resolution handle common path variants", async (t) => {
  assert.equal(getImageExtension("https://example.com/a.jpeg?x=1"), "jpeg");
  assert.equal(getImageExtension("/tmp/figure"), "png");

  const root = await makeTempDir("baoyu-md-images-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const baseDir = path.join(root, "article");
  const tempDir = path.join(root, "tmp");
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(path.join(baseDir, "figure.webp"), "webp");

  const resolved = await resolveImagePath("figure.png", baseDir, tempDir, "test");
  assert.equal(resolved, path.join(baseDir, "figure.webp"));
});

test("resolveContentImages resolves image placeholders against the content directory", async (t) => {
  const root = await makeTempDir("baoyu-md-content-images-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const baseDir = path.join(root, "article");
  const tempDir = path.join(root, "tmp");
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(path.join(baseDir, "cover.png"), "png");

  const resolved = await resolveContentImages(
    [
      {
        alt: "cover",
        originalPath: "cover.png",
        placeholder: "IMG_1",
      },
    ],
    baseDir,
    tempDir,
    "test",
  );

  assert.deepEqual(resolved, [
    {
      alt: "cover",
      originalPath: "cover.png",
      placeholder: "IMG_1",
      localPath: path.join(baseDir, "cover.png"),
    },
  ]);
});

test("downloadFile follows relative redirects, caps redirect hops, and leaves no partial file on error", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(307, { Location: "/final.png" });
      res.end();
      return;
    }
    if (req.url === "/final.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from([137, 80, 78, 71]));
      return;
    }
    if (req.url?.startsWith("/loop")) {
      res.writeHead(302, { Location: "/loop" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const root = await makeTempDir("baoyu-md-download-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const okPath = path.join(root, "ok.png");
  await downloadFile(`${baseUrl}/start`, okPath);
  const bytes = await fs.readFile(okPath);
  assert.deepEqual(Array.from(bytes), [137, 80, 78, 71]);

  const loopPath = path.join(root, "loop.png");
  await assert.rejects(() => downloadFile(`${baseUrl}/loop`, loopPath), /Too many redirects \(max 5\)/);
  await assert.rejects(() => fs.access(loopPath));

  const missingPath = path.join(root, "missing.png");
  await assert.rejects(() => downloadFile(`${baseUrl}/missing`, missingPath), /Failed to download: 404/);
  await assert.rejects(() => fs.access(missingPath));
});
