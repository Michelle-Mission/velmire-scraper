import { createDecipheriv } from "node:crypto";
import axios from "axios";
import { config } from "../shared/config";

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
export function solveCastPow(nonce: string, difficulty: number, timeoutMs = 20000): string | null {
  if (!Number.isFinite(difficulty) || difficulty <= 0) return "0";
  const prefix = `${nonce}:`;
  const started = Date.now();
  for (let counter = 0; ; counter++) {
    if (leadingZeroBits(castHash(latin1(prefix + counter))) >= difficulty) {
      return String(counter);
    }
    if (counter % 2048 === 2047 && Date.now() - started > timeoutMs) return null;
  }
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
    const solution = solveCastPow(challenge.pow_nonce, Number(challenge.pow_difficulty ?? 0));
    if (solution === null) return undefined;
    const verified = await requestJson<CastVerify>("POST", `${base}/captcha/verify`, headers, {
      pow_token: challenge.pow_token,
      solution,
    });
    if (verified?.status !== "ok" || typeof verified.token !== "string") return undefined;
    token = verified.token;
  }

  const playback = await requestJson<EncryptedPlayback>(
    "POST",
    `${base}/playback`,
    token ? { ...headers, "X-Captcha-Token": token } : headers,
    { fingerprint: {} },
  );
  if (!playback) return undefined;
  return pickHlsSource(decryptCastPlayback(playback));
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
