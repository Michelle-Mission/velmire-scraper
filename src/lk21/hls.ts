import axios from "axios";
import { config } from "../shared/config";
import { validateUrl } from "../shared/url-guard";
import { ScrapeError } from "./http";

export interface ProxyResult {
  status: number;
  contentType: string;
  contentRange?: string;
  acceptRanges?: string;
  body: Buffer;
}

/** Rewrite a media URL so it is fetched back through the unified stream proxy. */
function toProxy(absolute: string): string {
  return `/v1/stream?proxy=1&url=${encodeURIComponent(absolute)}`;
}

/** Resolve a possibly relative URI against the playlist and route it locally. */
function proxyUri(uri: string, base: URL): string {
  try {
    return toProxy(new URL(uri, base).toString());
  } catch {
    return uri;
  }
}

/**
 * Rewrite an HLS manifest so every child playlist, segment and key URI is
 * fetched through `/v1/stream?proxy=1` (same origin as the UI, so no CORS).
 */
export function rewritePlaylist(text: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.length === 0) return line;
      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${proxyUri(uri, base)}"`);
      }
      return proxyUri(line.trim(), base);
    })
    .join("\n");
}

/**
 * Auto-detecting media proxy for a single endpoint: HLS playlists get their
 * URIs rewritten, everything else is streamed through as raw bytes (with
 * HTTP Range support).
 */
export async function proxyMedia(url: string, range?: string): Promise<ProxyResult> {
  const absolute = await ensureAllowed(url);
  const headers: Record<string, string> = { ...mediaHeaders(absolute) };
  if (range) headers.Range = range;

  const response = await axios.get(absolute, {
    timeout: config.FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: () => true,
    proxy: false,
    responseType: "arraybuffer",
    decompress: false,
    headers,
  });

  const responseHeaders = response.headers as Record<string, unknown>;
  const raw = response.data;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

  if (buffer.subarray(0, 7).toString("latin1") === "#EXTM3U") {
    return {
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      body: Buffer.from(rewritePlaylist(buffer.toString("utf8"), absolute), "utf8"),
    };
  }

  if (response.status !== 200 && response.status !== 206) {
    throw new ScrapeError(
      `Gagal memuat media (HTTP ${response.status})`,
      "media_fetch_failed",
      502,
    );
  }

  return {
    status: response.status,
    contentType: String(responseHeaders["content-type"] ?? "application/octet-stream"),
    contentRange: responseHeaders["content-range"] as string | undefined,
    acceptRanges: responseHeaders["accept-ranges"] as string | undefined,
    body: buffer,
  };
}

function mediaHeaders(url: string): Record<string, string> {
  return {
    "User-Agent": config.USER_AGENT,
    Accept: "*/*",
    "Accept-Encoding": "identity",
    "Accept-Language": config.ACCEPT_LANGUAGE,
    Referer: `${new URL(url).origin}/`,
  };
}

function ensureAllowed(url: string): Promise<string> {
  return validateUrl(url, {
    allowedHosts: [],
    allowedPorts: config.ALLOWED_PORTS,
    allowPrivateHosts: config.ALLOW_PRIVATE_HOSTS,
    skipAllowlist: true,
  }).then((guard) => {
    if (!guard.ok) throw new ScrapeError(guard.reason, guard.code, 400);
    return url;
  });
}
