import axios, { type AxiosResponse } from "axios";
import { ALLOWED_HOSTS, config } from "../shared/config";
import { validateUrl } from "../shared/url-guard";
import type { FetchInfo } from "../shared/types";

export interface FetchedPage extends FetchInfo {
  html: string;
}

export class ScrapeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 502,
  ) {
    super(message);
    this.name = "ScrapeError";
  }
}

// Strong markers only appear on an actual Cloudflare interstitial.
const STRONG_CHALLENGE_MARKERS = [
  "just a moment",
  "checking your browser",
  "cf-chl",
  "__cf_chl",
  "cf_challenge",
  "attention required",
  "enable javascript and cookies",
];

// Weak markers are also embedded on regular pages (e.g. the LK21 "Nontondrama"
// redirect page loads `/cdn-cgi/challenge-platform/scripts/jsd/main.js`), so they
// only count as a challenge when the response status is suspicious.
const WEAK_CHALLENGE_MARKERS = ["challenge-platform", "turnstile"];

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function guardOptions() {
  return {
    allowedHosts: ALLOWED_HOSTS,
    allowedPorts: config.ALLOWED_PORTS,
    allowPrivateHosts: config.ALLOW_PRIVATE_HOSTS,
  };
}

function browserHeaders(): Record<string, string> {
  return {
    "User-Agent": config.USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": config.ACCEPT_LANGUAGE,
    "Upgrade-Insecure-Requests": "1",
  };
}

function detectChallenge(
  statusCode: number,
  headers: Record<string, unknown>,
  html: string,
): { detected: boolean; solved: boolean } {
  const body = html.slice(0, 30000).toLowerCase();
  const strong = STRONG_CHALLENGE_MARKERS.some((needle) => body.includes(needle));
  const weak = WEAK_CHALLENGE_MARKERS.some((needle) => body.includes(needle));
  const cfRay = Boolean(headers["cf-ray"]);
  const mitigated = String(headers["cf-mitigated"] ?? "").toLowerCase();
  const statusSuspicious =
    statusCode === 403 || statusCode === 429 || statusCode === 503;
  const detected =
    strong || mitigated === "challenge" || (cfRay && statusSuspicious) || (weak && statusSuspicious);
  const solved = !strong && !weak && statusCode < 400;
  return { detected, solved };
}

async function requestOnce(
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<AxiosResponse<string>> {
  return axios.request<string>({
    url,
    method: "GET",
    timeout: config.FETCH_TIMEOUT_MS,
    responseType: "text",
    maxRedirects: 0,
    validateStatus: () => true,
    decompress: true,
    proxy: false,
    maxContentLength: config.MAX_HTML_BYTES,
    maxBodyLength: config.MAX_HTML_BYTES,
    headers: { ...browserHeaders(), ...extraHeaders },
  });
}

interface CloudscraperResponse {
  ok: boolean;
  status_code?: number;
  url?: string;
  html?: string;
  error?: string;
}

async function fetchViaCloudscraper(
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ html: string; statusCode: number; finalUrl: string }> {
  const headers: Record<string, string> = {};
  if (config.CLOUDSCRAPER_TOKEN) headers["X-Auth-Token"] = config.CLOUDSCRAPER_TOKEN;

  let data: CloudscraperResponse;
  try {
    const response = await axios.post<CloudscraperResponse>(
      `${config.CLOUDSCRAPER_URL}/fetch`,
      {
        url,
        timeout_ms: config.CLOUDSCRAPER_TIMEOUT_MS,
        max_bytes: config.MAX_HTML_BYTES,
        user_agent: config.USER_AGENT,
        headers: { "Accept-Language": config.ACCEPT_LANGUAGE, ...extraHeaders },
      },
      {
        timeout: config.CLOUDSCRAPER_TIMEOUT_MS + 5000,
        headers,
        validateStatus: () => true,
        proxy: false,
      },
    );
    if (response.status !== 200) {
      throw new ScrapeError(
        `cloudscraper service responded with HTTP ${response.status}`,
        "cloudscraper_error",
      );
    }
    data = response.data;
  } catch (error) {
    if (error instanceof ScrapeError) throw error;
    const err = error as NodeJS.ErrnoException;
    const code = err.code ?? "";
    const raw = err.message ?? String(error);
    const connectionIssue =
      ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"].includes(
        code,
      ) || /socket hang up|ECONNREFUSED|ECONNRESET|timeout/i.test(raw);
    if (connectionIssue) {
      throw new ScrapeError(
        `Cloudflare challenge terdeteksi dan sidecar cloudscraper tidak dapat dihubungi di ` +
          `${config.CLOUDSCRAPER_URL} (${code || raw}). Jalankan "./run-web.sh" agar sidecar ikut hidup, ` +
          `atau set CLOUDSCRAPER_ENABLED=false untuk melewatinya.`,
        "cloudscraper_unreachable",
        502,
      );
    }
    throw new ScrapeError(
      `Cloudflare challenge terdeteksi dan sidecar cloudscraper gagal: ${raw}`,
      "cloudscraper_error",
      502,
    );
  }

  if (!data.ok) {
    throw new ScrapeError(
      `Cloudflare challenge detected but not solved by cloudscraper: ${data.error ?? "unknown reason"}`,
      "challenge_not_solved",
    );
  }

  return {
    html: data.html ?? "",
    statusCode: data.status_code ?? 200,
    finalUrl: data.url ?? url,
  };
}

export interface FetchOptions {
  /** When true, the URL (and each redirect) is validated against the allowlist. */
  guard?: boolean;
  /** Extra request headers merged on top of the default browser headers. */
  headers?: Record<string, string>;
}

/**
 * Fetch a page as HTML. Uses a direct request first and only delegates to the
 * Python cloudscraper sidecar when a Cloudflare-style challenge is detected.
 */
export async function fetchPage(
  raw: string,
  options: FetchOptions = {},
): Promise<FetchedPage> {
  let current = raw;

  if (options.guard) {
    const guard = await validateUrl(raw, guardOptions());
    if (!guard.ok) throw new ScrapeError(guard.reason, guard.code, 400);
    current = guard.url.toString();
  }

  let response: AxiosResponse<string> | undefined;
  for (let hop = 0; hop <= config.FETCH_MAX_REDIRECTS; hop += 1) {
    response = await requestOnce(current, options.headers);

    const location = response.headers["location"] as string | undefined;
    if (REDIRECT_STATUS.has(response.status) && location) {
      const next = new URL(location, current).toString();
      if (options.guard) {
        const guard = await validateUrl(next, { ...guardOptions(), skipAllowlist: true });
        if (!guard.ok) {
          throw new ScrapeError(
            `Blocked redirect to ${next}: ${guard.reason}`,
            "redirect_blocked",
            400,
          );
        }
      }
      current = next;
      continue;
    }
    break;
  }

  if (!response) throw new ScrapeError("No response received from target", "no_response");

  const html =
    typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  const challenge = detectChallenge(
    response.status,
    response.headers as Record<string, unknown>,
    html,
  );

  if (!challenge.detected) {
    return {
      engine: "direct",
      statusCode: response.status,
      finalUrl: current,
      html,
    };
  }

  if (!config.CLOUDSCRAPER_ENABLED) {
    throw new ScrapeError(
      "Cloudflare challenge detected but the cloudscraper service is disabled (CLOUDSCRAPER_ENABLED=false)",
      "challenge_not_solved",
    );
  }

  const solved = await fetchViaCloudscraper(current, options.headers);
  return { engine: "cloudscraper", ...solved };
}

export async function fetchJson<T>(
  raw: string,
  options: FetchOptions = {},
): Promise<T> {
  const page = await fetchPage(raw, options);
  try {
    return JSON.parse(page.html) as T;
  } catch {
    throw new ScrapeError("Target did not return valid JSON", "invalid_json");
  }
}

/**
 * Follow the redirect chain of a URL using HEAD requests and return the final
 * absolute URL. Used to detect the active LK21 mirror (whose origin must match
 * the `Referer` expected by the search API).
 */
export async function resolveFinalUrl(raw: string): Promise<string> {
  let current = raw;
  for (let hop = 0; hop <= config.FETCH_MAX_REDIRECTS; hop += 1) {
    const response = await axios.request({
      url: current,
      method: "HEAD",
      timeout: config.FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      proxy: false,
      headers: browserHeaders(),
    });
    const location = response.headers["location"] as string | undefined;
    if (REDIRECT_STATUS.has(response.status) && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return current;
  }
  return current;
}
