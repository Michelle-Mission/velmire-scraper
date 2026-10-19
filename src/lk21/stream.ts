import axios from "axios";
import type Redis from "ioredis";
import { config } from "../shared/config";
import { cacheKey, remember } from "../shared/cache";
import { validateUrl } from "../shared/url-guard";
import { ScrapeError } from "./http";

export interface StreamInfo {
  /** Server label from the source page, e.g. `p2p`, `cast`, `hydrax`. */
  server: string;
  /** Original player page (wrapper) reported by the scraper. */
  player: string;
  /** Real player URL resolved from the wrapper (`/api.php`). */
  embed: string;
  /** Whether `embed` may be loaded inside an iframe on this origin. */
  embeddable: boolean;
  /** Direct HLS (`.m3u8`) URL when the provider exposes one (e.g. `p2p`). */
  hls?: string;
}

function browserHeaders(playerUrl: string): Record<string, string> {
  return {
    "User-Agent": config.USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": config.ACCEPT_LANGUAGE,
    Referer: playerUrl,
  };
}

/** Extract `{ server, id }` from a wrapper URL like `/iframe3/<server>/<id>`. */
function parsePlayerPath(playerUrl: string): { server: string; id: string } | null {
  try {
    const parts = new URL(playerUrl).pathname.split("/").filter(Boolean);
    const index = parts.indexOf("iframe3");
    if (index === -1 || parts.length < index + 3) return null;
    return { server: parts[index + 1], id: parts[index + 2] };
  } catch {
    return null;
  }
}

async function resolveEmbed(playerUrl: string): Promise<string> {
  const parsed = parsePlayerPath(playerUrl);
  if (!parsed) {
    throw new ScrapeError(
      `Tidak dapat membaca server dari URL player: ${playerUrl}`,
      "invalid_player_url",
      400,
    );
  }

  const origin = new URL(playerUrl).origin;
  const response = await axios.post(
    `${origin}/api.php`,
    new URLSearchParams({ host: parsed.server, id: parsed.id }).toString(),
    {
      timeout: config.FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      proxy: false,
      headers: {
        ...browserHeaders(playerUrl),
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );

  let payload: { embedUrl?: string } | undefined;
  if (typeof response.data === "string") {
    try {
      payload = JSON.parse(response.data) as { embedUrl?: string };
    } catch {
      payload = undefined;
    }
  } else {
    payload = response.data as { embedUrl?: string } | undefined;
  }

  const embed = payload?.embedUrl;
  if (response.status !== 200 || !embed) {
    throw new ScrapeError(
      `Gagal resolve player (HTTP ${response.status})`,
      "stream_resolve_failed",
      502,
    );
  }
  return embed;
}

/** Some providers expose the direct HLS manifest through a `/verify` call. */
async function resolveHls(embedUrl: string): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(embedUrl);
  } catch {
    return undefined;
  }
  if (!/(^|\.)playcdn\.de$/i.test(url.hostname)) return undefined;

  const slug = url.pathname.split("/").filter(Boolean)[0];
  if (!slug || slug === "verify") return undefined;

  try {
    const response = await axios.get(`${url.origin}/verify/${slug}`, {
      timeout: config.FETCH_TIMEOUT_MS,
      maxRedirects: 3,
      validateStatus: () => true,
      proxy: false,
      responseType: "json",
      headers: browserHeaders(embedUrl),
    });
    const fileUrl = (response.data as { fileUrl?: string } | undefined)?.fileUrl;
    if (response.status === 200 && typeof fileUrl === "string" && /^https?:\/\//i.test(fileUrl)) {
      return fileUrl;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A player is embeddable unless it denies framing via CSP/X-Frame-Options. */function isEmbeddable(headers: Record<string, unknown>): boolean {
  const csp = String(headers["content-security-policy"] ?? "").toLowerCase();
  const xfo = String(headers["x-frame-options"] ?? "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;
  const frameAncestors = csp.match(/frame-ancestors([^;]*)/);
  if (frameAncestors) {
    const sources = frameAncestors[1].trim().split(/\s+/);
    if (!sources.includes("*")) return false;
  }
  return true;
}

async function probeEmbeddable(embedUrl: string): Promise<boolean> {
  try {
    const response = await axios.get(embedUrl, {
      timeout: config.FETCH_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      proxy: false,
      responseType: "text",
      headers: browserHeaders(embedUrl),
    });
    return isEmbeddable(response.headers as Record<string, unknown>);
  } catch {
    return false;
  }
}

export function resolveStream(redis: Redis, playerUrl: string): Promise<StreamInfo> {
  const key = cacheKey(["stream", playerUrl]);
  return remember(redis, key, async () => {
    const guard = await validateUrl(playerUrl, {
      allowedHosts: [],
      allowedPorts: config.ALLOWED_PORTS,
      allowPrivateHosts: config.ALLOW_PRIVATE_HOSTS,
      skipAllowlist: true,
    });
    if (!guard.ok) throw new ScrapeError(guard.reason, guard.code, 400);

    const parsed = parsePlayerPath(playerUrl);
    if (!parsed) {
      throw new ScrapeError(`URL player tidak valid: ${playerUrl}`, "invalid_player_url", 400);
    }

    const embed = await resolveEmbed(playerUrl);
    const embeddable = await probeEmbeddable(embed);
    const hls = await resolveHls(embed);
    if (hls) return { server: parsed.server, player: playerUrl, embed, embeddable, hls } satisfies StreamInfo;
    return { server: parsed.server, player: playerUrl, embed, embeddable } satisfies StreamInfo;
  });
}
