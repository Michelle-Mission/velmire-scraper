import { createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import axios from "axios";
import type Redis from "ioredis";
import { cacheKey, getJson, setJson } from "../shared/cache";
import { config } from "../shared/config";
import { validateUrl } from "../shared/url-guard";
import { ScrapeError } from "../http/http";

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

/** A player is embeddable unless it denies framing via CSP/X-Frame-Options. */
function isEmbeddable(headers: Record<string, unknown>): boolean {
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

/**
 * Resolver for the `cast` player (Byse frontend, e.g. `mfw09.org`).
 *
 * The embed page is a single-page app that requires a proof-of-work challenge
 * before it returns the playback configuration. The configuration is encrypted
 * with AES-256-GCM; the key is split into `key_parts` and only two of them are
 * selected by `version` (indices `[version, 31 - version]`, 1-based).
 */

interface CastEmbed {
  origin: string;
  code: string;
}

interface CastSettings {
  captcha_required?: boolean;
}

interface CastChallenge {
  pow_nonce?: string;
  pow_difficulty?: number;
  pow_token?: string;
}

interface CastVerify {
  status?: string;
  token?: string;
}

interface EncryptedPlayback {
  algorithm?: string;
  iv?: string;
  payload?: string;
  key_parts?: string[];
  version?: string | number;
}

interface PlaybackSource {
  url?: string;
  mime_type?: string;
  height?: number;
}

interface PlaybackConfig {
  sources?: PlaybackSource[];
}

const HASH_STATE = new Uint32Array(4);
const HASH_TABLE = new Uint32Array(512);
const HASH_OUT = new Uint32Array(8);

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function mix(state: Uint32Array): void {
  state[0] = (state[0] + state[1]) >>> 0;
  state[3] = rotl(state[3] ^ state[0], 16);
  state[2] = (state[2] + state[3]) >>> 0;
  state[1] = rotl(state[1] ^ state[2], 12);
  state[0] = (state[0] + state[1]) >>> 0;
  state[3] = rotl(state[3] ^ state[0], 8);
  state[2] = (state[2] + state[3]) >>> 0;
  state[1] = rotl(state[1] ^ state[2], 7);
}

/**
 * Provider-specific hash (a 512-word SipHash-like construction). Ported
 * verbatim from the player bundle so proof-of-work solutions match.
 */
export function castHash(input: Uint8Array): Uint32Array {
  const state = HASH_STATE;
  state[0] = 1779033703;
  state[1] = 3144134277;
  state[2] = 1013904242;
  state[3] = 2773480762;

  for (let i = 0; i < input.length; i++) {
    state[0] = (state[0] + input[i]) >>> 0;
    state[0] = rotl(state[0], 7);
    mix(state);
  }
  for (let i = 0; i < 8; i++) mix(state);

  const table = HASH_TABLE;
  for (let i = 0; i < 512; i++) {
    mix(state);
    table[i] = (state[0] ^ state[2]) >>> 0;
  }
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 512; i++) {
      const index = table[i] & 511;
      let value = (table[i] + table[index]) >>> 0;
      value = rotl(value, 13);
      value = (value ^ Math.imul(table[(i + 1) & 511], 2654435761)) >>> 0;
      table[i] = value;
      state[0] = (state[0] ^ value) >>> 0;
      mix(state);
    }
  }

  const out = HASH_OUT;
  for (let i = 0; i < 8; i++) {
    mix(state);
    let value = state[0] >>> 0;
    const offset = i * 64;
    for (let j = 0; j < 64; j++) {
      const word = table[offset + j];
      value = (value + word) >>> 0;
      value = rotl(value, 5);
      value = (value ^ Math.imul(word, 2246822519)) >>> 0;
    }
    out[i] = (value ^ state[2]) >>> 0;
  }
  return out;
}

function leadingZeroBits(words: Uint32Array): number {
  let bits = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === 0) {
      bits += 32;
      continue;
    }
    return bits + Math.clz32(word);
  }
  return bits;
}

function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255;
  return bytes;
}

/**
 * Find the smallest counter so that `hash(nonce + ":" + counter)` has at least
 * `difficulty` leading zero bits. Mirrors the browser solver, including the
 * 20 second budget.
 */
export async function solveCastPow(
  nonce: string,
  difficulty: number,
  timeoutMs = 20000,
): Promise<string | null> {
  if (!Number.isFinite(difficulty) || difficulty <= 0) return "0";
  const prefix = `${nonce}:`;
  const started = Date.now();
  for (let counter = 0; ; counter++) {
    if (leadingZeroBits(castHash(latin1(prefix + counter))) >= difficulty) {
      return String(counter);
    }
    if ((counter & 511) === 511) {
      if (Date.now() - started > timeoutMs) return null;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const HASH_STATE = new Uint32Array(4);
const HASH_TABLE = new Uint32Array(512);
const HASH_OUT = new Uint32Array(8);
${rotl.toString()}
${mix.toString()}
${castHash.toString()}
${leadingZeroBits.toString()}
${latin1.toString()}
const { prefix, difficulty, start, step, timeoutMs } = workerData;
const started = Date.now();
for (let counter = start; ; counter += step) {
  if (leadingZeroBits(castHash(latin1(prefix + counter))) >= difficulty) {
    parentPort.postMessage({ solution: String(counter) });
    break;
  }
  if ((counter & 1023) === 1023 && Date.now() - started > timeoutMs) {
    parentPort.postMessage({ solution: null });
    break;
  }
}
`;

/**
 * Run the proof-of-work across several worker threads. Each worker scans a
 * disjoint counter sequence and the first valid solution wins.
 */
export async function solveCastPowParallel(
  nonce: string,
  difficulty: number,
  timeoutMs = 20000,
  workerCount?: number,
): Promise<string | null> {
  if (!Number.isFinite(difficulty) || difficulty <= 0) return "0";
  const workers = Math.max(
    2,
    Math.min(workerCount ?? 8, Math.max(2, availableParallelism() - 1)),
  );
  if (workers <= 1) return solveCastPow(nonce, difficulty, timeoutMs);
  const prefix = `${nonce}:`;

  return new Promise<string | null>((resolve) => {
    const active = new Set<Worker>();
    let settled = false;
    const finish = (solution: string | null) => {
      if (settled) return;
      settled = true;
      for (const worker of active) void worker.terminate().catch(() => undefined);
      active.clear();
      resolve(solution);
    };

    try {
      for (let index = 0; index < workers; index++) {
        const worker = new Worker(WORKER_SOURCE, {
          eval: true,
          execArgv: [],
          workerData: { prefix, difficulty, start: index, step: workers, timeoutMs },
        });
        active.add(worker);
        worker.on("message", (message: { solution?: string | null }) => {
          if (typeof message?.solution === "string") {
            finish(message.solution);
            return;
          }
          active.delete(worker);
          void worker.terminate().catch(() => undefined);
          if (active.size === 0) finish(null);
        });
        worker.on("error", () => {
          active.delete(worker);
          if (active.size === 0) finish(null);
        });
        worker.on("exit", () => {
          active.delete(worker);
          if (active.size === 0) finish(null);
        });
      }
    } catch {
      finish(null);
    }
  });
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padding), "base64");
}

/** Decrypt the AES-256-GCM playback payload returned by the cast provider. */
export function decryptCastPlayback(playback: EncryptedPlayback): PlaybackConfig {
  const parts = playback.key_parts;
  const version = Number(playback.version);
  if (!Array.isArray(parts) || !Number.isInteger(version) || version < 1 || version > 20) {
    throw new Error("invalid cast playback key");
  }
  const indices = [version, 31 - version].filter((index) => index >= 1 && index <= parts.length);
  const key = Buffer.concat(indices.map((index) => decodeBase64Url(parts[index - 1])));
  if (key.length !== 32) throw new Error("invalid cast playback key length");
  if (typeof playback.iv !== "string" || typeof playback.payload !== "string") {
    throw new Error("invalid cast playback payload");
  }

  const iv = decodeBase64Url(playback.iv);
  const data = decodeBase64Url(playback.payload);
  if (data.length <= 16) throw new Error("invalid cast playback ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as PlaybackConfig;
}

/** Extract the share code from an embed URL such as `https://host/e/<code>`. */
export function parseCastEmbed(embedUrl: string): CastEmbed | null {
  try {
    const url = new URL(embedUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part === "e" || part === "d");
    if (index === -1 || index + 1 >= parts.length) return null;
    const code = parts[index + 1];
    if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
    return { origin: url.origin, code };
  } catch {
    return null;
  }
}

function requestHeaders(embedUrl: string, parent: string): Record<string, string> {
  const origin = new URL(embedUrl).origin;
  return {
    "User-Agent": config.USER_AGENT,
    Accept: "application/json",
    "Accept-Language": config.ACCEPT_LANGUAGE,
    Referer: embedUrl,
    Origin: origin,
    "X-Embed-Origin": parent,
    "X-Embed-Referer": `${parent}/`,
    "X-Embed-Parent": parent,
  };
}

async function requestJson<T>(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T | null> {
  const response = await axios.request({
    method,
    url,
    data: body,
    timeout: config.FETCH_TIMEOUT_MS,
    maxRedirects: 0,
    validateStatus: () => true,
    proxy: false,
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
  });
  if (response.status !== 200) return null;
  if (typeof response.data === "string") {
    try {
      return JSON.parse(response.data) as T;
    } catch {
      return null;
    }
  }
  return (response.data ?? null) as T | null;
}

function pickHlsSource(configData: PlaybackConfig): string | undefined {
  const sources = Array.isArray(configData.sources) ? configData.sources : [];
  const hls = sources.filter((source) => {
    if (typeof source.url !== "string" || source.url.length === 0) return false;
    const mime = String(source.mime_type ?? "").toLowerCase();
    return mime.includes("mpegurl") || /\.m3u8(\?|$)/i.test(source.url);
  });
  hls.sort((left, right) => (right.height ?? 0) - (left.height ?? 0));
  return hls[0]?.url;
}

async function resolveWithParent(
  embed: CastEmbed,
  embedUrl: string,
  parent: string,
): Promise<string | undefined> {
  const headers = requestHeaders(embedUrl, parent);
  const base = `${embed.origin}/api/videos/${encodeURIComponent(embed.code)}/embed`;

  const settings = await requestJson<CastSettings>("GET", `${base}/settings`, headers);
  if (!settings) return undefined;

  let token: string | undefined;
  if (settings.captcha_required !== false) {
    const challenge = await requestJson<CastChallenge>("POST", `${base}/captcha`, headers, {});
    if (!challenge || typeof challenge.pow_nonce !== "string" || typeof challenge.pow_token !== "string") {
      return undefined;
    }
    const solution = await solveCastPowParallel(
      challenge.pow_nonce,
      Number(challenge.pow_difficulty ?? 0),
    );
    if (solution === null) return undefined;
    const verified = await requestJson<CastVerify>("POST", `${base}/captcha/verify`, headers, {
      pow_token: challenge.pow_token,
      solution,
    });
    if (verified?.status !== "ok" || typeof verified.token !== "string") return undefined;
    token = verified.token;
  }

  const response = await requestJson<{ playback?: EncryptedPlayback }>(
    "POST",
    `${base}/playback`,
    { ...headers, ...(token ? { "X-Captcha-Token": token } : {}) },
    { fingerprint: {} },
  );
  if (!response?.playback) return undefined;
  return pickHlsSource(decryptCastPlayback(response.playback));
}

/**
 * Resolve a direct HLS URL from a `cast`/Byse embed. Returns `undefined` when
 * the provider does not expose a playable HLS manifest.
 */
export async function resolveCastHls(
  embedUrl: string,
  parentOrigin: string,
): Promise<string | undefined> {
  const embed = parseCastEmbed(embedUrl);
  if (!embed) return undefined;

  const parents = [parentOrigin.replace(/\/+$/, ""), "https://videonode.de"].filter(
    (parent, index, all) => parent.length > 0 && all.indexOf(parent) === index,
  );
  for (const parent of parents) {
    try {
      const hls = await resolveWithParent(embed, embedUrl, parent);
      if (hls) return hls;
    } catch {
      // Try the next allowed parent; the wrapper may change its domain.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Signed stream URLs
// ---------------------------------------------------------------------------

const STREAM_SECRET =
  config.STREAM_SECRET.length > 0 ? config.STREAM_SECRET : randomBytes(32).toString("hex");

if (config.STREAM_SECRET.length === 0 && config.NODE_ENV !== "test") {
  console.warn("[stream] STREAM_SECRET is not set; signed stream URLs will not survive a restart");
}

interface StreamTokenPayload {
  u: string;
  e: number;
}

/** Sign an upstream media URL so it can be proxied through `/stream/:token`. */
export function signStreamToken(url: string): string {
  const expires = Math.floor(Date.now() / 1000) + config.STREAM_TOKEN_TTL_SECONDS;
  const data: StreamTokenPayload = { u: url, e: expires };
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  const signature = createHmac("sha256", STREAM_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** Validate a stream token and return the signed upstream URL. */
export function verifyStreamToken(token: string): string {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    throw new ScrapeError("Token stream tidak valid", "invalid_stream_token", 400);
  }
  const expected = createHmac("sha256", STREAM_SECRET).update(payload).digest("base64url");
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new ScrapeError("Token stream tidak valid", "invalid_stream_token", 400);
  }

  let data: StreamTokenPayload;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StreamTokenPayload;
  } catch {
    throw new ScrapeError("Token stream tidak valid", "invalid_stream_token", 400);
  }
  if (typeof data?.u !== "string" || !Number.isFinite(data.e)) {
    throw new ScrapeError("Token stream tidak valid", "invalid_stream_token", 400);
  }
  if (data.e < Math.floor(Date.now() / 1000)) {
    throw new ScrapeError("Token stream kedaluwarsa", "stream_token_expired", 410);
  }
  return data.u;
}

/** Build the public, same-origin URL used by players for an upstream media URL. */
export function streamUrlFor(url: string): string {
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return `${base}/stream/${signStreamToken(url)}`;
}

export interface ProxyResult {
  status: number;
  contentType: string;
  contentRange?: string;
  acceptRanges?: string;
  body: Buffer;
}

/** Resolve a possibly relative URI against the playlist and route it locally. */
function proxyUri(uri: string, base: URL): string {
  try {
    const absolute = new URL(uri, base);
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return uri;
    return streamUrlFor(absolute.toString());
  } catch {
    return uri;
  }
}

/**
 * Rewrite an HLS manifest so every child playlist, segment and key URI is
 * fetched through the signed `/stream/:token` endpoint (same origin as the UI,
 * so no CORS).
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
  let buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

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

  const contentRange = responseHeaders["content-range"] as string | undefined;
  return {
    status: response.status,
    contentType: String(responseHeaders["content-type"] ?? "application/octet-stream"),
    contentRange,
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

// ---------------------------------------------------------------------------
// Player resolution
// ---------------------------------------------------------------------------

interface CachedStream {
  server: string;
  player: string;
  embed: string;
  embeddable: boolean;
  upstreamHls?: string;
}

function publicStream(cached: CachedStream): StreamInfo {
  return {
    server: cached.server,
    player: cached.player,
    embed: cached.embed,
    embeddable: cached.embeddable,
    hls: cached.upstreamHls ? streamUrlFor(cached.upstreamHls) : undefined,
  };
}

/**
 * Resolve an LK21 player wrapper into a same-origin HLS URL (preferred) or an
 * embeddable player page (fallback).
 */
export async function resolveStream(redis: Redis, playerUrl: string): Promise<StreamInfo> {
  const key = cacheKey(["stream:v2", playerUrl]);
  const cached = await getJson<CachedStream>(redis, key);
  if (cached !== null) return publicStream(cached);

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
  let upstreamHls: string | undefined;
  if (parsed.server === "cast") {
    upstreamHls = await resolveCastHls(embed, new URL(playerUrl).origin).catch(() => undefined);
  } else {
    upstreamHls = await resolveHls(embed);
  }
  const embeddable = upstreamHls ? true : await probeEmbeddable(embed);

  const resolved: CachedStream = {
    server: parsed.server,
    player: playerUrl,
    embed,
    embeddable,
    upstreamHls,
  };

  // Signed stream URLs expire; keep the cache shorter than the token lifetime.
  const ttl = upstreamHls
    ? Math.min(config.CACHE_TTL_SECONDS, 600)
    : parsed.server === "cast"
      ? 120
      : config.CACHE_TTL_SECONDS;
  await setJson(redis, key, resolved, ttl);
  return publicStream(resolved);
}
