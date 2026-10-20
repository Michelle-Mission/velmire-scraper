import type Redis from "ioredis";
import { config, LK21_BASE, LK21_MOVIES_BASE, LK21_POSTER_BASE, LK21_SEARCH_BASE } from "../shared/config";
import { cacheKey, remember } from "../shared/cache";
import type {
  ContentType,
  DetailResult,
  EpisodeResult,
  FiltersResult,
  HomeResult,
  ListItem,
  ListResult,
  TaxonomyItem,
} from "../shared/types";
import { fetchJson, fetchPage, resolveFinalUrl, ScrapeError, type FetchedPage } from "./http";
import {
  parseDetail,
  parseEpisode,
  parseHome,
  parseLanding,
  parseList,
  parseNav,
  parseTaxonomyLinks,
} from "./parsers";

const MOVIE_LIST_PATHS = {
  latest: "latest",
  popular: "populer",
  rating: "rating",
  release: "release",
} as const;

/** `series` is handled separately because it lives on the series site. */
export const LIST_KINDS = ["latest", "popular", "rating", "release", "series"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export const SERIES_FILTERS = ["ongoing", "complete", "west", "asian"] as const;
export type SeriesFilter = (typeof SERIES_FILTERS)[number];

export const MOVIE_LIST_KINDS = ["home", "latest", "popular", "top"] as const;
export type MovieListKind = (typeof MOVIE_LIST_KINDS)[number];

const MOVIE_PORTAL_PATHS: Record<MovieListKind, string> = {
  home: "",
  latest: "latest",
  popular: "populer",
  top: "top-movie-today",
};

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
      const page = await fetchPage(url);
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

export async function getHome(redis: Redis, limit: number): Promise<HomeResult> {
  const capped = clampLimit(limit);
  const key = cacheKey(["home", LK21_BASE, capped]);
  return remember(redis, key, async () => {
    const page = await fetchPage(`${LK21_BASE}/`);
    const home = parseHome(page.html, LK21_BASE);
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
  const path = kind === "series" ? "latest-series" : MOVIE_LIST_PATHS[kind];
  return aggregatedList(redis, LK21_BASE, path, options);
}

export async function getByGenre(
  redis: Redis,
  slug: string,
  _type: ContentType,
  options: ListOptions,
): Promise<ListResult> {
  return aggregatedList(redis, LK21_BASE, `genre/${encodeURIComponent(slug)}`, options);
}

export async function getByCountry(
  redis: Redis,
  slug: string,
  _type: ContentType,
  options: ListOptions,
): Promise<ListResult> {
  return aggregatedList(redis, LK21_BASE, `country/${encodeURIComponent(slug)}`, options);
}

export async function getByYear(
  redis: Redis,
  year: string,
  _type: ContentType,
  options: ListOptions,
): Promise<ListResult> {
  return aggregatedList(redis, LK21_BASE, `year/${encodeURIComponent(year)}`, options);
}

const FILTER_PREFIXES = ["genre/", "country/", "year/", "series/"] as const;
const FILTER_EXACT = ["latest", "populer", "rating", "release", "latest-series"] as const;

function normalizeFilterPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
}

function isSupportedFilterPath(path: string): boolean {
  return (
    (FILTER_EXACT as readonly string[]).includes(path) ||
    FILTER_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/** Scrape the navbar of the source and expose its filter groups. */
export async function getFilters(redis: Redis): Promise<FiltersResult> {
  const key = cacheKey(["filters", LK21_BASE, LK21_MOVIES_BASE]);
  return remember(redis, key, async () => {
    const page = await fetchPage(`${LK21_BASE}/`);
    return {
      groups: parseNav(page.html, LK21_BASE, { moviesBase: LK21_MOVIES_BASE }),
    } satisfies FiltersResult;
  });
}

/**
 * Scrape any tv9 filter path from the navbar, e.g. `series/ongoing`,
 * `genre/action`, `country/japan` or `year/2026`.
 */
export function getFilter(
  redis: Redis,
  path: string,
  options: ListOptions,
): Promise<ListResult> {
  const clean = normalizeFilterPath(path);
  if (!isSupportedFilterPath(clean)) {
    throw new ScrapeError(
      `Filter "${path}" tidak didukung; gunakan genre/…, country/…, year/…, atau series/…`,
      "invalid_filter",
      400,
    );
  }
  if (clean.startsWith("series/")) {
    const filter = clean.slice("series/".length);
    if (!(SERIES_FILTERS as readonly string[]).includes(filter)) {
      throw new ScrapeError(
        `Filter series "${filter}" tidak dikenal; pilih ${SERIES_FILTERS.join(", ")}`,
        "invalid_filter",
        400,
      );
    }
  }
  return aggregatedList(redis, LK21_BASE, clean, options);
}

export function getSeriesFilter(
  redis: Redis,
  filter: string,
  options: ListOptions,
): Promise<ListResult> {
  if (!(SERIES_FILTERS as readonly string[]).includes(filter)) {
    throw new ScrapeError(
      `Filter series "${filter}" tidak dikenal; pilih ${SERIES_FILTERS.join(", ")}`,
      "invalid_filter",
      400,
    );
  }
  return aggregatedList(redis, LK21_BASE, `series/${filter}`, options);
}

async function aggregatedMovieList(
  redis: Redis,
  path: string,
  options: ListOptions,
  root: boolean,
): Promise<ListResult> {
  const key = cacheKey([
    "movies",
    LK21_MOVIES_BASE,
    path,
    root ? 1 : 0,
    options.page,
    options.pages,
    options.limit,
  ]);
  return remember(redis, key, async () => {
    const items: ListItem[] = [];
    let totalPages: number | null = null;
    let fetchedPages = 0;

    for (let offset = 0; offset < options.pages; offset += 1) {
      const currentPage = options.page + offset;
      if (root && offset > 0) break;
      const requested =
        root && currentPage === 1
          ? `${LK21_MOVIES_BASE}/`
          : `${LK21_MOVIES_BASE}/${path}/page/${currentPage}`;

      // `d21.team` is a landing host: follow it to the live movie site.
      const landing = await fetchPage(requested);
      const info = parseLanding(landing.html, landing.finalUrl);
      const target =
        info.isLanding && (info.continueUrl || info.homeUrl)
          ? await fetchPage(info.continueUrl ?? info.homeUrl ?? requested)
          : landing;

      const parsed = parseList(target.html, LK21_BASE);
      if (totalPages === null && parsed.totalPages !== null) totalPages = parsed.totalPages;
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

/** Scrape the movie portal linked from the navbar (`d21.team → lk21.de`). */
export function getMovieList(
  redis: Redis,
  kind: MovieListKind,
  options: ListOptions,
): Promise<ListResult> {
  const path = MOVIE_PORTAL_PATHS[kind];
  return aggregatedMovieList(redis, path, options, kind === "home");
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

/** The search API only answers requests whose referer matches the live site. */
async function searchReferer(): Promise<string> {
  if (config.LK21_REFERER) return config.LK21_REFERER;
  if (cachedReferer) return cachedReferer;
  try {
    const finalUrl = await resolveFinalUrl(`${LK21_BASE}/`);
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
        Referer: await searchReferer(),
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
      },
    });
    const source = data.data ?? data.items ?? [];
    const items: ListItem[] = source.map((entry) => {
      const slug = entry.slug ?? "";
      const type: ContentType = entry.type === "movie" ? "movie" : "series";
      return {
        title: entry.title ?? "",
        slug,
        url: `${LK21_BASE}/${slug}`,
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

function slugOf(ref: { url?: string; slug?: string }): string {
  return ref.url ? slugFromUrl(ref.url) : normalizeSlug(ref.slug as string);
}

function isDetailPage(html: string): boolean {
  return (
    html.includes('id="watch-history-data"') ||
    html.includes("id='watch-history-data'") ||
    html.includes('id="season-data"') ||
    html.includes("id='season-data'") ||
    /class=["'][^"']*\bmovie-info\b/.test(html)
  );
}

export function getMovie(redis: Redis, ref: { url?: string; slug?: string }): Promise<DetailResult> {
  if (!ref.url && !ref.slug) {
    throw new ScrapeError("Either \"url\" or \"slug\" is required for movie", "missing_reference", 400);
  }
  const key = cacheKey(["movie", ref.url ?? "", ref.slug ?? ""]);
  return remember(redis, key, async () => {
    const slug = slugOf(ref);
    const page = await fetchDetailPage(slug);
    return parseDetail(page.html, `${LK21_BASE}/${slug}`, LK21_BASE);
  });
}

/**
 * Fetch a tv9 detail page. Movie slugs redirect to a promo landing page that
 * links to the live movie site, so follow it once and keep the emitted URLs on
 * the configured tv9 base.
 */
async function fetchDetailPage(slug: string): Promise<FetchedPage> {
  const page = await fetchPage(`${LK21_BASE}/${slug}`);
  const landing = parseLanding(page.html, page.finalUrl);
  const target = landing.isLanding && landing.continueUrl ? await fetchPage(landing.continueUrl) : page;

  if (target.statusCode === 404 || target.statusCode === 410 || !isDetailPage(target.html)) {
    throw new ScrapeError(`Content "${slug}" was not found`, "not_found", 404);
  }
  return target;
}

export function getEpisode(redis: Redis, ref: { url?: string; slug?: string }): Promise<EpisodeResult> {
  if (!ref.url && !ref.slug) {
    throw new ScrapeError("Either \"url\" or \"slug\" is required for episode", "missing_reference", 400);
  }
  const key = cacheKey(["episode", ref.url ?? "", ref.slug ?? ""]);
  return remember(redis, key, async () => {
    const slug = slugOf(ref);
    const page = await fetchDetailPage(slug);
    const episode = parseEpisode(page.html, `${LK21_BASE}/${slug}`, LK21_BASE);
    if (episode.season === null && episode.episode === null) {
      throw new ScrapeError(
        `"${slug}" is a series page, not an episode; use /v1/movie?slug=${encodeURIComponent(slug)}`,
        "not_an_episode",
        400,
      );
    }
    return episode;
  });
}

async function taxonomy(
  redis: Redis,
  kind: "genre" | "country",
  _type: ContentType,
): Promise<TaxonomyItem[]> {
  const key = cacheKey(["taxonomy", kind, LK21_BASE]);
  return remember(redis, key, async () => {
    const page = await fetchPage(`${LK21_BASE}/`);
    return parseTaxonomyLinks(page.html, LK21_BASE, kind);
  });
}

export function getGenres(redis: Redis, type: ContentType = "movie"): Promise<TaxonomyItem[]> {
  return taxonomy(redis, "genre", type);
}

export function getCountries(redis: Redis, type: ContentType = "movie"): Promise<TaxonomyItem[]> {
  return taxonomy(redis, "country", type);
}
