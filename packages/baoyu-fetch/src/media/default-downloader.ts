import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  buildFileName,
  isDataUri,
  normalizeContentType,
  normalizeMediaUrl,
  resolveExtensionFromContentType,
  resolveExtensionFromUrl,
  resolveMediaKind,
  resolveOutputExtension,
  toPosixPath,
} from "./media-utils";
import type { MediaAsset, MediaDownloadRequest, MediaDownloadResult, MediaKind } from "./types";

const DOWNLOAD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function assertHttpsUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid media URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Only HTTPS media downloads are allowed: ${rawUrl}`);
  }
  return parsed;
}

function stripCrossOriginAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "cookie") {
      continue;
    }
    next[key] = value;
  }
  return next;
}

async function fetchHttpsMedia(
  initialUrl: string,
  extraHeaders?: Record<string, string>,
): Promise<{ response: Response; finalUrl: string }> {
  let current = assertHttpsUrl(initialUrl);
  let headers: Record<string, string> = {
    "user-agent": DOWNLOAD_USER_AGENT,
    ...(extraHeaders ?? {}),
  };
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Media download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
    }

    const response = await fetch(current.href, {
      method: "GET",
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(remainingMs),
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new Error(`Redirect (${response.status}) missing Location header`);
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
      }
      const nextUrl = assertHttpsUrl(new URL(location, current).href);
      if (nextUrl.origin !== current.origin) {
        headers = stripCrossOriginAuthHeaders(headers);
      }
      current = nextUrl;
      continue;
    }

    return { response, finalUrl: response.url || current.href };
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

function parseBase64DataUri(rawUrl: string): { contentType: string; bytes: Buffer } | null {
  const match = rawUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const contentType = normalizeContentType(match[1]);
  if (!contentType) {
    return null;
  }

  try {
    const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (bytes.length === 0) {
      return null;
    }
    return { contentType, bytes };
  } catch {
    return null;
  }
}

function dedupeMedia(media: MediaAsset[]): MediaAsset[] {
  const deduped: MediaAsset[] = [];
  const seen = new Set<string>();
  for (const item of media) {
    const normalizedUrl = normalizeMediaUrl(item.url);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }
    seen.add(normalizedUrl);
    deduped.push({
      ...item,
      url: normalizedUrl,
    });
  }
  return deduped;
}

function toRelativePath(fromDir: string, absoluteTarget: string): string {
  const relative = path.relative(fromDir, absoluteTarget) || path.basename(absoluteTarget);
  return toPosixPath(relative);
}

export async function downloadMediaAssets(
  request: MediaDownloadRequest,
): Promise<MediaDownloadResult> {
  const dedupedMedia = dedupeMedia(request.media);
  const absoluteOutputPath = path.resolve(request.outputPath);
  const markdownDir = path.dirname(absoluteOutputPath);
  const baseDir = request.mediaDir ? path.resolve(request.mediaDir) : markdownDir;
  const replacements: MediaDownloadResult["replacements"] = [];

  let downloadedImages = 0;
  let downloadedVideos = 0;

  for (const asset of dedupedMedia) {
    try {
      let sourceUrl = normalizeMediaUrl(asset.url);
      let contentType = "";
      let extension: string | undefined;
      let kind: MediaKind | undefined;
      let bytes: Buffer | null = null;

      if (isDataUri(asset.url)) {
        const parsed = parseBase64DataUri(asset.url);
        if (!parsed) {
          request.log.warn(`Skipping unsupported embedded media: ${asset.url.slice(0, 32)}...`);
          continue;
        }

        contentType = parsed.contentType;
        extension =
          resolveExtensionFromContentType(contentType) ??
          resolveExtensionFromUrl(asset.fileNameHint ?? "");
        kind = resolveMediaKind(sourceUrl, contentType, extension, asset.kind);
        bytes = parsed.bytes;
      } else {
        const { response, finalUrl } = await fetchHttpsMedia(sourceUrl, asset.headers);

        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          request.log.warn(`Skipping media (${response.status}): ${asset.url}`);
          continue;
        }

        sourceUrl = normalizeMediaUrl(finalUrl);
        contentType = normalizeContentType(response.headers.get("content-type"));
        extension =
          resolveExtensionFromUrl(sourceUrl) ??
          resolveExtensionFromUrl(asset.url) ??
          resolveExtensionFromUrl(asset.fileNameHint ?? "");
        kind = resolveMediaKind(sourceUrl, contentType, extension, asset.kind);
        if (!kind) {
          await response.body?.cancel().catch(() => {});
          request.log.warn(
            `Skipping media with unsupported content-type (${contentType || "unknown"}): ${asset.url}`,
          );
          continue;
        }
        bytes = Buffer.from(await response.arrayBuffer());
      }

      if (!kind || !bytes) {
        request.log.debug(`Skipping media with unresolved kind: ${asset.url}`);
        continue;
      }

      const outputExtension = resolveOutputExtension(contentType, extension, kind);
      const nextIndex = kind === "image" ? downloadedImages + 1 : downloadedVideos + 1;
      const dirName = kind === "image" ? "imgs" : "videos";
      const targetDir = path.join(baseDir, dirName);
      await mkdir(targetDir, { recursive: true });

      const fileName = buildFileName(kind, nextIndex, sourceUrl, outputExtension, asset.fileNameHint);
      const absolutePath = path.join(targetDir, fileName);
      await writeFile(absolutePath, bytes);

      replacements.push({
        url: asset.url,
        localPath: toRelativePath(markdownDir, absolutePath),
        absolutePath,
        kind,
      });

      if (kind === "image") {
        downloadedImages = nextIndex;
      } else {
        downloadedVideos = nextIndex;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.log.warn(`Failed to download media ${asset.url}: ${message}`);
    }
  }

  return {
    replacements,
    downloadedImages,
    downloadedVideos,
    imageDir: downloadedImages > 0 ? path.join(baseDir, "imgs") : null,
    videoDir: downloadedVideos > 0 ? path.join(baseDir, "videos") : null,
  };
}
