import "dotenv/config";
import { z } from "zod";

function csvList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function boolFromEnv(def: boolean) {
  return z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === "") return def;
      return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    });
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  /** Base URL of the single LK21 source to scrape (tv9 / Nontondrama). */
  LK21_URL: z.string().default("https://tv9.nontondrama.my"),
  /** Base URL that serves the JSON search endpoint (`search.php`). */
  LK21_SEARCH_URL: z.string().default("https://gudangvape.com/"),
  /** Base URL for relative poster paths returned by the search API. */
  LK21_POSTER_URL: z.string().default("https://poster.assetsy.de/wp-content/uploads/"),
  /**
   * Optional explicit `Referer` for the search API. When empty it is
   * auto-detected from the active mirror reached via `LK21_URL` redirects.
   */
  LK21_REFERER: z.string().default(""),

  ALLOWED_HOSTS: z.string().default("").transform(csvList),
  ALLOWED_PORTS: z
    .string()
    .default("80,443")
    .transform((value) =>
      csvList(value)
        .map((part) => Number(part))
        .filter((port) => Number.isInteger(port) && port > 0 && port < 65536),
    ),
  ALLOW_PRIVATE_HOSTS: boolFromEnv(false),

  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  FETCH_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  MAX_HTML_BYTES: z.coerce.number().int().positive().default(2_000_000),
  USER_AGENT: z
    .string()
    .default(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
  ACCEPT_LANGUAGE: z.string().default("id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7"),

  CLOUDSCRAPER_ENABLED: boolFromEnv(true),
  CLOUDSCRAPER_URL: z.string().default("http://127.0.0.1:8000"),
  CLOUDSCRAPER_TOKEN: z.string().optional(),
  CLOUDSCRAPER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(1800),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  CORS_ORIGIN: z.string().default("*"),

  /** Maximum number of source pages that a single request may aggregate. */
  MAX_PAGES_PER_REQUEST: z.coerce.number().int().min(1).max(50).default(20),
  /** Default number of items returned per listing when `limit` is not set. */
  DEFAULT_LIST_LIMIT: z.coerce.number().int().min(1).max(200).default(24),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "Invalid environment configuration:",
    JSON.stringify(parsed.error.issues, null, 2),
  );
  process.exit(1);
}

export const config = parsed.data;

export const LK21_BASE = withoutTrailingSlash(config.LK21_URL);
export const LK21_SEARCH_BASE = withTrailingSlash(config.LK21_SEARCH_URL);
export const LK21_POSTER_BASE = withTrailingSlash(config.LK21_POSTER_URL);

function resolveAllowedHosts(): string[] {
  if (config.ALLOWED_HOSTS.length > 0) return config.ALLOWED_HOSTS;
  const hosts = new Set<string>();
  for (const base of [LK21_BASE, LK21_SEARCH_BASE, LK21_POSTER_BASE]) {
    const host = hostOf(base);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

export const ALLOWED_HOSTS = resolveAllowedHosts();

export type Config = typeof config;
