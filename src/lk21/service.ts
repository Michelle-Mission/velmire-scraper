import type Redis from "ioredis";
import {
  config,
  LK21_BASE,
  LK21_POSTER_BASE,
  LK21_SEARCH_BASE,
  LK21_SERIES_BASE,
} from "../shared/config";
import { cacheKey, remember } from "../shared/cache";
import type {
  ContentType,
  DetailResult,
  EpisodeResult,
  HomeResult,
  ListItem,
  ListResult,
  TaxonomyItem,
} from "../shared/types";
import {
  fetchJson,
  fetchPage,
  resolveFinalUrl,
  ScrapeError,
  type FetchOptions,
  type FetchedPage,
} from "./http";
import {
  parseDetail,
  parseEpisode,
  parseHome,
  parseLanding,
  parseList,
  parseTaxonomyLinks,
} from "./parsers";

/** Hosts discovered at runtime (e.g. the real site behind a landing page). */
const extraHosts = new Set<string>();

/** Memoized real-base resolution keyed by the configured base. */
const realBaseCache = new Map<string, Promise<string>>();

function sourceFetch(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
  return fetchPage(url, { ...options, extraHosts: [...extraHosts] });
}

/**
 * Some rotating domains only serve a promo "landing" page that links to the
 * real site. Probe the configured base once and swap it for the real origin so
 * every endpoint keeps working no matter which promo domain is configured.
 */
function realBase(redis: Redis, configured: string): Promise<string> {
  const cached = realBaseCache.get(configured);
  if (cached) return cached;

  const resolved = remember(redis, cacheKey(["realbase", configured]), async () => {
    try {
      const page = await sourceFetch(`${configured}/`);
      const landing = parseLanding(page.html, page.finalUrl);
      if (landing.isLanding && landing.homeUrl) {
        const target = new URL(landing.homeUrl);
        if (target.hostname !== new URL(configured).hostname) {
          extraHosts.add(target.hostname);
          return target.origin;
        }
      }
    } catch {
      /* fall back to the configured base */
    }
    return configured;
  });

  realBaseCache.set(configured, resolved);
  return resolved;
}

function baseForType(redis: Redis, type: ContentType): Promise<string> {
  return type === "series"
    ? realBase(redis, LK21_SERIES_BASE)
    : realBase(redis, LK21_BASE);
}

const MOVIE_LIST_PATHS = {
  latest: "latest",
  popular: "populer",
  rating: "rating",
  release: "release",
} as const;

/** `series` is handled separately because it lives on the series site. */
export const LIST_KINDS = ["latest", "popular", "rating", "release", "series"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export interface ListOptions {
  page: number;
  pages: number;
  limit: number;
}

function clampPage(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function clampPages(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), config.MAX_PAGES_PER_REQUEST);
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value < 1) return config.DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(value), 200);
}

export function normalizeListOptions(query: {
  page?: number;
  pages?: number;
  limit?: number;
}): ListOptions {
  return {
    page: clampPage(query.page),
    pages: clampPages(query.pages),
    limit: clampLimit(query.limit),
  };
}

export function parseContentType(value: unknown): ContentType {
  return value === "series" ? "series" : "movie";
}

async function aggregatedList(
  redis: Redis,
  base: string,
  path: string,
  options: ListOptions,
): Promise<ListResult> {
  const key = cacheKey(["list", base, path, options.page, options.pages, options.limit]);
  return remember(redis, key, async () => {
    const items: ListItem[] = [];
    let totalPages: number | null = null;
    let fetchedPages = 0;

    for (let offset = 0; offset < options.pages; offset += 1) {
      const currentPage = options.page + offset;
      const url = `${base}/${path}/page/${currentPage}`;
      const page = await sourceFetch(url);
      const parsed = parseList(page.html, base);

      if (totalPages === null && parsed.totalPages !== null) {
        totalPages = parsed.totalPages;
      }
      items.push(...parsed.items);
      fetchedPages += 1;

      if (items.length >= options.limit) break;
      if (parsed.items.length === 0) break;
      if (totalPages !== null && currentPage >= totalPages) break;
    }

    const limited = items.slice(0, options.limit);
    return {
      page: options.page,
      pages: fetchedPages,
      totalPages,
      count: limited.length,
      items: limited,
    } satisfies ListResult;
  });
}

export async function getHome(redis: Redis, limit: number, type: ContentType = "movie"): Promise<HomeResult> {
  const capped = clampLimit(limit);
  const base = await baseForType(redis, type);
  const key = cacheKey(["home", base, capped]);
  return remember(redis, key, async () => {
    const page = await sourceFetch(`${base}/`);
    const home = parseHome(page.html, base);
    return {
      sections: home.sections.map((section) => ({
        ...section,
        items: section.items.slice(0, capped),
        count: Math.min(section.count, capped),
      })),
    } satisfies HomeResult;
  });
}

export async function getList(
  redis: Redis,
  kind: ListKind,
  options: ListOptions,
): Promise<ListResult> {
  if (kind === "series") {
    return aggregatedList(redis, await realBase(redis, LK21_SERIES_BASE), "latest-series", options);
  }
  return aggregatedList(redis, await realBase(redis, LK21_BASE), MOVIE_LIST_PATHS[kind], options);
}

export async function getByGenre(
  redis: Redis,
  slug: string,
  type: ContentType,
  options: ListOptions,
): Promise<ListResult> {
  return aggregatedList(
    redis,
    await baseForType(redis, type),
    `genre/${encodeURIComponent(slug)}`,
    options,
  );
}

export async function getByCountry(
  redis: Redis,
  slug: string,
  type: ContentType,
  options: ListOptions,
): Promise<ListResult> {
  return aggregatedList(
    redis,
    await baseForType(redis, type),
    `country/${encodeURIComponent(slug)}`,
    options,
  );
}

export async function getByYear(
  redis: Redis,
  year: string,
  type: ContentType,
  options: ListOptions,
): Promise<ListResult> {
  return aggregatedList(
    redis,
    await baseForType(redis, type),
    `year/${encodeURIComponent(year)}`,
    options,
  );
}

interface SearchItem {
  title?: string;
  slug?: string;
  type?: string;
  poster?: string;
  quality?: string;
  rating?: number | string;
  year?: number | string;
  episode?: number | string;
  season?: number | string;
  runtime?: string;
  is_complete?: number;
}

interface SearchResponse {
  totalPages?: number;
  total_pages?: number;
  data?: SearchItem[];
  items?: SearchItem[];
  error?: string;
}

function posterFromSearch(poster: string | undefined): string | null {
  if (!poster) return null;
  if (/^https?:\/\//i.test(poster)) return poster;
  return `${LK21_POSTER_BASE}${poster.replace(/^\/+/, "")}`;
}

function toNumberOrNull(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveIntOrNull(value: number | string | undefined): number | null {
  const parsed = toNumberOrNull(value);
  if (parsed === null || parsed < 1) return null;
  return Math.floor(parsed);
}

let cachedReferer: string | null = null;

/**
 * The search API rejects requests whose `Referer` does not match the active
 * mirror origin. `LK21_URL` may be a stable alias that redirects to a rotating
 * mirror (or a promo landing page), so resolve the real base first and reuse
 * its final origin.
 */
async function searchReferer(redis: Redis): Promise<string> {
  if (config.LK21_REFERER) return config.LK21_REFERER;
  if (cachedReferer) return cachedReferer;
  try {
    const base = await realBase(redis, LK21_BASE);
    const finalUrl = await resolveFinalUrl(`${base}/`);
    cachedReferer = `${new URL(finalUrl).origin}/`;
  } catch {
    cachedReferer = `${LK21_BASE}/`;
  }
  return cachedReferer;
}

export function search(
  redis: Redis,
  query: string,
  page: number,
  limit: number,
): Promise<ListResult> {
  const currentPage = clampPage(page);
  const capped = clampLimit(limit);
  const key = cacheKey(["search", query, currentPage, capped]);
  return remember(redis, key, async () => {
    const url = `${LK21_SEARCH_BASE}search.php?s=${encodeURIComponent(query)}&page=${currentPage}`;
    const data = await fetchJson<SearchResponse>(url, {
      headers: {
        Referer: await searchReferer(redis),
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
      },
    });
    const source = data.data ?? data.items ?? [];
    const [movieBase, seriesBase] = await Promise.all([
      baseForType(redis, "movie"),
      baseForType(redis, "series"),
    ]);
    const items: ListItem[] = source.map((entry) => {
      const slug = entry.slug ?? "";
      const type: ContentType = entry.type === "movie" ? "movie" : "series";
      return {
        title: entry.title ?? "",
        slug,
        url: `${type === "series" ? seriesBase : movieBase}/${slug}`,
        type,
        poster: posterFromSearch(entry.poster),
        rating: toNumberOrNull(entry.rating) || null,
        year: toNumberOrNull(entry.year),
        episode: toPositiveIntOrNull(entry.episode),
        season: toPositiveIntOrNull(entry.season),
        duration: entry.runtime || null,
        quality: entry.quality || null,
        genres: [],
        complete: entry.is_complete === 1,
      } satisfies ListItem;
    });

    const totalPages = data.totalPages ?? data.total_pages ?? null;
    const limited = items.slice(0, capped);
    return {
      page: currentPage,
      pages: 1,
      totalPages,
      count: limited.length,
      items: limited,
    } satisfies ListResult;
  });
}

/** The movie site shows a "redirecting to Nontondrama" page for series slugs. */
function isSeriesRedirect(html: string): boolean {
  const sample = html.slice(0, 6000).toLowerCase();
  return sample.includes("nontondrama") && sample.includes("dialihkan ke");
}

function normalizeSlug(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Extract the content slug, honouring the `?page=<slug>` form used by the movie site. */
function slugFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get("page");
    return normalizeSlug(fromQuery ?? url.pathname);
  } catch {
    return normalizeSlug(value);
  }
}

export function getMovie(redis: Redis, ref: { url?: string; slug?: string }): Promise<DetailResult> {
  if (!ref.url && !ref.slug) {
    throw new ScrapeError("Either \"url\" or \"slug\" is required for movie", "missing_reference", 400);
  }
  const key = cacheKey(["movie", ref.url ?? "", ref.slug ?? ""]);
  return remember(redis, key, async () => {
    const movieBase = await realBase(redis, LK21_BASE);
    const seriesBase = await realBase(redis, LK21_SERIES_BASE);

    let page: FetchedPage;
    if (ref.url) {
      page = await fetchDetailPage(ref.url, movieBase);
    } else {
      page = await sourceFetch(`${movieBase}/${normalizeSlug(ref.slug as string)}`);
    }

    if (!isSeriesRedirect(page.html)) {
      return parseDetail(page.html, page.finalUrl, movieBase);
    }

    const slug = slugFromUrl(page.finalUrl);
    const series = await sourceFetch(`${seriesBase}/${slug}`);
    return parseDetail(series.html, series.finalUrl, seriesBase);
  });
}

/**
 * Fetch a detail page from an explicit URL. Follows the promo landing page to
 * the real site and falls back to the configured base when the host is not
 * allowed.
 */
async function fetchDetailPage(url: string, movieBase: string): Promise<FetchedPage> {
  let page: FetchedPage;
  try {
    page = await sourceFetch(url, { guard: true });
  } catch (error) {
    if (error instanceof ScrapeError && error.code === "host_not_allowed") {
      const slug = slugFromUrl(url);
      return sourceFetch(`${movieBase}/${slug}`);
    }
    throw error;
  }

  const landing = parseLanding(page.html, page.finalUrl);
  if (landing.isLanding) {
    const slug = slugFromUrl(page.finalUrl);
    const target = landing.continueUrl ?? `${movieBase}/${slug}`;
    page = await sourceFetch(target, { guard: true });
  }
  return page;
}

export function getEpisode(redis: Redis, ref: { url?: string; slug?: string }): Promise<EpisodeResult> {
  if (!ref.url && !ref.slug) {
    throw new ScrapeError("Either \"url\" or \"slug\" is required for episode", "missing_reference", 400);
  }
  const key = cacheKey(["episode", ref.url ?? "", ref.slug ?? ""]);
  return remember(redis, key, async () => {
    const seriesBase = await realBase(redis, LK21_SERIES_BASE);
    const page = ref.url
      ? await fetchDetailPage(ref.url, seriesBase)
      : await sourceFetch(`${seriesBase}/${normalizeSlug(ref.slug as string)}`);
    return parseEpisode(page.html, page.finalUrl, seriesBase);
  });
}

async function taxonomy(
  redis: Redis,
  kind: "genre" | "country",
  type: ContentType,
): Promise<TaxonomyItem[]> {
  const base = await baseForType(redis, type);
  const key = cacheKey(["taxonomy", kind, base]);
  return remember(redis, key, async () => {
    const page = await sourceFetch(`${base}/`);
    return parseTaxonomyLinks(page.html, base, kind);
  });
}

export function getGenres(redis: Redis, type: ContentType = "movie"): Promise<TaxonomyItem[]> {
  return taxonomy(redis, "genre", type);
}

export function getCountries(redis: Redis, type: ContentType = "movie"): Promise<TaxonomyItem[]> {
  return taxonomy(redis, "country", type);
}
