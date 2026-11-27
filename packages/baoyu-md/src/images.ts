import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

export interface ImagePlaceholder {
  originalPath: string;
  placeholder: string;
  alt?: string;
}

export interface ResolvedImageInfo extends ImagePlaceholder {
  localPath: string;
}

export function replaceMarkdownImagesWithPlaceholders(
  markdown: string,
  placeholderPrefix: string,
): {
  images: ImagePlaceholder[];
  markdown: string;
} {
  const images: ImagePlaceholder[] = [];
  let imageCounter = 0;

  const rewritten = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
    const placeholder = `${placeholderPrefix}${++imageCounter}`;
    images.push({
      alt,
      originalPath: src,
      placeholder,
    });
    return placeholder;
  });

  return { images, markdown: rewritten };
}

export function getImageExtension(urlOrPath: string): string {
  const match = urlOrPath.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i);
  return match ? match[1]!.toLowerCase() : "png";
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function downloadFile(url: string, destPath: string, redirectCount = 0): Promise<void> {
  return await new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid download URL: ${url}`));
      return;
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      reject(new Error(`Unsupported download protocol: ${parsed.protocol}`));
      return;
    }

    const protocol = parsed.protocol === "https:" ? https : http;
    let settled = false;
    let file: fs.WriteStream | null = null;

    const cleanupFile = (): void => {
      if (file) {
        file.destroy();
        file = null;
      }
      fs.unlink(destPath, () => {});
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanupFile();
      reject(error);
    };

    const request = protocol.get(parsed, { headers: { "User-Agent": "Mozilla/5.0" } }, (response) => {
      const status = response.statusCode ?? 0;

      if (REDIRECT_STATUSES.has(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location) {
          fail(new Error(`Redirect (${status}) missing Location header`));
          return;
        }
        if (redirectCount >= MAX_REDIRECTS) {
          fail(new Error(`Too many redirects (max ${MAX_REDIRECTS})`));
          return;
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, parsed).href;
        } catch {
          fail(new Error(`Invalid redirect URL: ${location}`));
          return;
        }
        settled = true;
        void downloadFile(nextUrl, destPath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        fail(new Error(`Failed to download: ${status}`));
        return;
      }

      file = fs.createWriteStream(destPath);
      file.on("error", (error) => fail(error));
      response.on("error", (error) => fail(error));
      response.pipe(file);
      file.on("finish", () => {
        if (settled) return;
        file?.close((closeErr) => {
          if (settled) return;
          if (closeErr) {
            fail(closeErr);
            return;
          }
          settled = true;
          resolve();
        });
      });
    });

    request.on("error", (error) => fail(error));

    request.setTimeout(30_000, () => {
      request.destroy();
      fail(new Error("Download timeout"));
    });
  });
}

export async function resolveImagePath(
  imagePath: string,
  baseDir: string,
  tempDir: string,
  logLabel = "baoyu-md",
): Promise<string> {
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    const hash = createHash("md5").update(imagePath).digest("hex").slice(0, 8);
    const ext = getImageExtension(imagePath);
    const localPath = path.join(tempDir, `remote_${hash}.${ext}`);

    if (!fs.existsSync(localPath)) {
      console.error(`[${logLabel}] Downloading: ${imagePath}`);
      await downloadFile(imagePath, localPath);
    }
    return localPath;
  }

  const resolved = path.isAbsolute(imagePath)
    ? imagePath
    : path.resolve(baseDir, imagePath);
  return resolveLocalWithFallback(resolved, logLabel);
}

export async function resolveContentImages(
  images: ImagePlaceholder[],
  baseDir: string,
  tempDir: string,
  logLabel = "baoyu-md",
): Promise<ResolvedImageInfo[]> {
  const resolved: ResolvedImageInfo[] = [];

  for (const image of images) {
    resolved.push({
      ...image,
      localPath: await resolveImagePath(image.originalPath, baseDir, tempDir, logLabel),
    });
  }

  return resolved;
}

function resolveLocalWithFallback(resolved: string, logLabel: string): string {
  if (fs.existsSync(resolved)) {
    return resolved;
  }

  const ext = path.extname(resolved);
  const base = ext ? resolved.slice(0, -ext.length) : resolved;
  const alternatives = [
    `${base}.webp`,
    `${base}.jpg`,
    `${base}.jpeg`,
    `${base}.png`,
    `${base}.gif`,
    `${base}_original.png`,
    `${base}_original.jpg`,
  ].filter((candidate) => candidate !== resolved);

  for (const alternative of alternatives) {
    if (!fs.existsSync(alternative)) continue;
    console.error(
      `[${logLabel}] Image fallback: ${path.basename(resolved)} -> ${path.basename(alternative)}`,
    );
    return alternative;
  }

  return resolved;
}
