import type Redis from "ioredis";
import { config, LK21_BASE, LK21_POSTER_BASE, LK21_SEARCH_BASE } from "../shared/config";
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
import { fetchJson, fetchPage, resolveFinalUrl, ScrapeError, type FetchedPage } from "./http";
import {
  parseDetail,
  parseEpisode,
  parseHome,
  parseLanding,
  parseList,
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
  if (landing.isLanding && landing.continueUrl) {
    return fetchPage(landing.continueUrl);
  }
  return page;
}

export function getEpisode(redis: Redis, ref: { url?: string; slug?: string }): Promise<EpisodeResult> {
  if (!ref.url && !ref.slug) {
    throw new ScrapeError("Either \"url\" or \"slug\" is required for episode", "missing_reference", 400);
  }
  const key = cacheKey(["episode", ref.url ?? "", ref.slug ?? ""]);
  return remember(redis, key, async () => {
    const slug = slugOf(ref);
    const page = await fetchDetailPage(slug);
    return parseEpisode(page.html, `${LK21_BASE}/${slug}`, LK21_BASE);
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
