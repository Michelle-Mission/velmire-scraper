import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type {
  ContentType,
  DetailResult,
  EpisodeLink,
  EpisodeResult,
  HomeResult,
  HomeSection,
  ListItem,
  NavFilterItem,
  NavGroup,
  NavItemKind,
  SeasonGroup,
  StreamSource,
  TaxonomyItem,
} from "../../shared/types";

type CheerioAPI = cheerio.CheerioAPI;

function absUrl(href: string | undefined | null, base: string): string | null {
  if (!href || href === "#") return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function slugOf(url: string | null): string {
  if (!url) return "";
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path.split("/").pop() ?? "";
  } catch {
    return "";
  }
}

/**
 * Some series cards link to `/<section>?page=<slug>` instead of `/<slug>`.
 * Return the real slug when that pattern is used.
 */
function slugFromQuery(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const value = new URL(href, "http://placeholder").searchParams.get("page");
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function toNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitNames(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function imageOf($: CheerioAPI, poster: AnyNode): string | null {
  const $poster = $(poster);
  const img = $poster.find("img").first();
  const candidate =
    img.attr("src") ||
    img.attr("data-src") ||
    $poster.find("source[type='image/jpeg']").attr("srcset") ||
    $poster.find("source").first().attr("srcset");
  if (!candidate) return null;
  return candidate.trim().split(/\s+/)[0] ?? null;
}

function parseListItem($: CheerioAPI, article: AnyNode, base: string): ListItem | null {
  const $article = $(article);
  const $link = $article.find("a[itemprop='url']").first().length
    ? $article.find("a[itemprop='url']").first()
    : $article.find("a").first();
  const href = $link.attr("href");
  const rawUrl = absUrl(href, base);
  if (!rawUrl) return null;

  const querySlug = slugFromQuery(href);
  const slug = querySlug ?? slugOf(rawUrl);
  const url = querySlug ? absUrl(`/${querySlug}`, base) ?? rawUrl : rawUrl;

  const $poster = $article.find(".poster").first();
  const episode = toInt($poster.find(".episode strong").text());
  const durationText = $poster.find(".duration").text().trim();
  const season = /s\.\s*\d+/i.test(durationText) ? toInt(durationText) : null;
  const runtime = /^\d{1,2}:\d{2}$/.test(durationText) ? durationText : null;

  const title =
    $article.find(".poster-title").first().text().trim() ||
    $article.find("img").first().attr("alt")?.replace(/\s*\(\d{4}\)\s*$/, "").trim() ||
    "";

  const genres = unique([
    ...splitNames($article.find("figcaption .genre").first().text()),
    ...splitNames($article.find("meta[itemprop='genre']").attr("content")),
  ]);

  const type: ContentType = episode !== null ? "series" : "movie";

  const $quality = $poster
    .find("span")
    .filter((_, el) => /(^|\s)label-/.test($(el).attr("class") ?? ""))
    .first();

  return {
    title,
    slug,
    url,
    type,
    poster: imageOf($, $poster.get(0) as AnyNode),
    rating: toNumber(
      $poster.find("[itemprop='ratingValue']").first().text() ||
        $poster.find(".rating").first().text(),
    ),
    year: toInt($poster.find(".year").text()),
    episode,
    season,
    duration: runtime,
    quality: $quality.text().trim() || null,
    genres,
    complete: $poster.find(".episode.complete").length > 0,
  };
}

export interface ParsedList {
  totalPages: number | null;
  items: ListItem[];
}

export function parseList(html: string, base: string): ParsedList {
  const $ = cheerio.load(html);

  const headerText = $("div.main-section h3").first().text();
  const headerMatch = headerText.match(/dari\s+(\d+)\s+total/i);
  let totalPages = headerMatch ? toInt(headerMatch[1]) : null;

  if (totalPages === null) {
    const lastPage = $("ul.pagination a")
      .map((_, el) => $(el).attr("href") ?? "")
      .get()
      .map((href) => href.match(/\/page\/(\d+)/)?.[1])
      .map((value) => (value ? Number(value) : NaN))
      .filter((value) => Number.isFinite(value));
    if (lastPage.length > 0) totalPages = Math.max(...lastPage);
  }

  const $container = $("div.gallery-grid").first().length
    ? $("div.gallery-grid").first()
    : $("div.main-section").first();

  const items: ListItem[] = [];
  $container.find("article").each((_, article) => {
    const item = parseListItem($, article, base);
    if (item && item.url) items.push(item);
  });

  return { totalPages, items };
}

export function parseHome(html: string, base: string): HomeResult {
  const $ = cheerio.load(html);
  const sections: HomeSection[] = [];

  $(".widget").each((_, widget) => {
    const $widget = $(widget);
    const $articles = $widget.find("article");
    if ($articles.length === 0) return;

    const title =
      $widget.find(".header h2").first().text().trim() ||
      $widget.find(".header .widget-title").first().text().trim();
    if (!title) return;

    const items: ListItem[] = [];
    $articles.each((__, article) => {
      const item = parseListItem($, article, base);
      if (item && item.url) items.push(item);
    });
    if (items.length === 0) return;

    sections.push({
      title,
      seeAll: absUrl($widget.find(".header a").first().attr("href"), base),
      type: $widget.attr("data-type") ?? null,
      count: items.length,
      items,
    });
  });

  return { sections };
}

interface WatchData {
  id?: number;
  title?: string;
  rating?: string | number;
  poster?: string;
  slug?: string;
  year?: number;
  runtime?: string;
  total_eps?: number;
  total_season?: number;
  next?: string;
  current_season?: number;
  current_eps?: number;
}

interface SeasonEpisodeRaw {
  s?: number;
  episode_no?: number;
  title?: string;
  slug?: string;
}

type SeasonData = Record<string, SeasonEpisodeRaw[]>;

function readJsonScript<T>($: CheerioAPI, id: string): T | null {
  const raw = $(`script#${id}`).html();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseSeasonData(raw: SeasonData | null, base: string): SeasonGroup[] {
  if (!raw) return [];
  const seasons: SeasonGroup[] = [];
  for (const [key, list] of Object.entries(raw)) {
    const season = Number.parseInt(key, 10);
    if (!Number.isFinite(season) || !Array.isArray(list)) continue;
    const episodes: EpisodeLink[] = list
      .map((entry) => {
        const url = entry.slug ? absUrl(`/${entry.slug}`, base) : null;
        if (!url) return null;
        return {
          season: entry.s ?? season,
          episode: entry.episode_no ?? 0,
          title: entry.title ?? "",
          slug: entry.slug ?? "",
          url,
        } satisfies EpisodeLink;
      })
      .filter((entry): entry is EpisodeLink => entry !== null)
      .sort((a, b) => a.episode - b.episode);
    seasons.push({ season, episodes });
  }
  return seasons.sort((a, b) => a.season - b.season);
}

function parseStreams($: CheerioAPI): StreamSource[] {
  const seen = new Set<string>();
  const streams: StreamSource[] = [];
  const add = (url: string | undefined, server: string | undefined): void => {
    const value = (url ?? "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    streams.push({ server: (server ?? "").trim() || "unknown", url: value });
  };

  $("#player-list li a").each((_, el) => {
    const $el = $(el);
    add($el.attr("data-url") || $el.attr("href"), $el.attr("data-server") || $el.text());
  });
  // Some servers (e.g. "turbovip") only appear in the select fallback.
  $("#player-select option").each((_, el) => {
    const $el = $(el);
    const label = $el.text().replace(/ganti\s*player/i, "").trim();
    add($el.attr("value"), $el.attr("data-server") || label);
  });

  return streams;
}

function findActionLink($: CheerioAPI, matcher: RegExp): string | null {
  let found: string | null = null;
  $(".movie-action a, .player-action a").each((_, el) => {
    const $el = $(el);
    if (found) return;
    if (matcher.test($el.text())) {
      const href = $el.attr("href");
      if (href && href !== "#") found = href;
    }
  });
  return found;
}

function parseJsonLdPeople($: CheerioAPI): {
  director: string[];
  actors: string[];
  genres: string[];
  datePublished: string | null;
} {
  const directors: string[] = [];
  const actors: string[] = [];
  const genres: string[] = [];
  let datePublished: string | null = null;

  const addName = (target: string[], value: unknown): void => {
    if (typeof value === "string" && value.trim()) target.push(value.trim());
    else if (Array.isArray(value)) value.forEach((item) => addName(target, item));
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      addName(target, record.name);
    }
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = ($(el).html() ?? "").trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const record = node as Record<string, unknown>;
      addName(directors, record.director);
      addName(actors, record.actor);
      addName(genres, record.genre);
      if (typeof record.datePublished === "string") datePublished = record.datePublished;
    }
  });

  return { director: unique(directors), actors: unique(actors), genres: unique(genres), datePublished };
}

function parseTaxonomy($: CheerioAPI): {
  genres: string[];
  countries: string[];
} {
  const genres: string[] = [];
  const countries: string[] = [];
  $(".tag-list .tag a").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const name = $(el).text().trim();
    if (!name) return;
    if (href.includes("/genre/")) genres.push(name);
    else if (href.includes("/country/")) countries.push(name);
  });
  return { genres: unique(genres), countries: unique(countries) };
}

export function parseDetail(html: string, url: string, base: string): DetailResult {
  const $ = cheerio.load(html);
  const watch = readJsonScript<WatchData>($, "watch-history-data");
  const seasonData = readJsonScript<SeasonData>($, "season-data");
  const seasons = parseSeasonData(seasonData, base);
  const jsonLd = parseJsonLdPeople($);

  const infoTags = $(".info-tag span")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  const status =
    infoTags.find((tag) => /^(ongoing|complete|completed|end|ended|hiatus)$/i.test(tag)) ??
    null;
  const resolution =
    infoTags.find((tag) => /^\d{3,4}p$/i.test(tag)) ?? null;
  const quality =
    infoTags.find((tag) => /(bluray|web-?dl|webrip|hdtv|cam|hdts|hdrip|dvd)/i.test(tag)) ??
    null;
  const runtimeTag =
    infoTags.find((tag) => /^\d{1,2}:\d{2}$/.test(tag) || /^\d+h\s*\d+m$/i.test(tag)) ??
    null;

  const seasonsList = parseTaxonomy($);
  const genres = unique([...seasonsList.genres, ...jsonLd.genres]);
  const isSeries = seasons.length > 0 || (watch?.total_eps ?? 0) >= 1;

  const slug = watch?.slug || slugOf(url);
  const detailUrl = absUrl(`/${slug}`, base) ?? url;
  const totalEpisodes =
    watch?.total_eps ??
    (seasons.length
      ? seasons.reduce((sum, season) => sum + season.episodes.length, 0)
      : null);

  return {
    title: $("h1").first().text().trim() || watch?.title || "",
    slug,
    url: detailUrl,
    type: isSeries ? "series" : "movie",
    poster: watch?.poster ? absUrl(watch.poster, base) : null,
    rating: toNumber(typeof watch?.rating === "number" ? String(watch.rating) : watch?.rating),
    year: watch?.year ?? null,
    duration: watch?.runtime ?? runtimeTag,
    quality,
    resolution,
    status,
    synopsis: $(".synopsis").first().text().replace(/\s+/g, " ").trim() || null,
    trailer:
      absUrl($(".trailer-series iframe").first().attr("src"), base) ||
      absUrl($("a.yt-lightbox").first().attr("href"), base),
    genres,
    countries: seasonsList.countries,
    directors: jsonLd.director,
    casts: jsonLd.actors,
    downloadUrl: findActionLink($, /download/i),
    streams: parseStreams($),
    playFirst: absUrl(findActionLink($, /play\s*awal/i), base),
    playLatest: absUrl(findActionLink($, /play\s*terbaru/i), base),
    totalSeasons: watch?.total_season ?? (seasons.length || null),
    totalEpisodes,
    seasons,
  };
}

export function parseEpisode(html: string, url: string, base: string): EpisodeResult {
  const $ = cheerio.load(html);
  const watch = readJsonScript<WatchData>($, "watch-history-data");
  const seasonData = readJsonScript<SeasonData>($, "season-data");
  const seasons = parseSeasonData(seasonData, base);
  const episodes = seasons.flatMap((season) => season.episodes);

  const currentSlug = slugOf(url);
  const index = episodes.findIndex((entry) => entry.slug === currentSlug);
  const prev: EpisodeLink | null = index > 0 ? (episodes[index - 1] ?? null) : null;
  let next: EpisodeLink | null =
    index >= 0 && index + 1 < episodes.length ? (episodes[index + 1] ?? null) : null;

  if (!next && watch?.next) {
    const nextUrl = absUrl(`/${watch.next}`, base);
    if (nextUrl) {
      next = {
        season: watch.current_season ?? 0,
        episode: (watch.current_eps ?? 0) + 1,
        title: episodes.find((entry) => entry.slug === watch.next)?.title ?? "",
        slug: watch.next,
        url: nextUrl,
      };
    }
  }

  const preview = $(".main-player video").first();

  return {
    title: $("h1").first().text().trim(),
    slug: currentSlug,
    url,
    poster: absUrl(watch?.poster ?? preview.attr("poster"), base),
    year: watch?.year ?? null,
    series: watch?.slug ? { title: watch.title ?? "", slug: watch.slug } : null,
    season: watch?.current_season ?? null,
    episode: watch?.current_eps ?? null,
    streams: parseStreams($),
    defaultStream: absUrl($("#main-player").first().attr("src"), base),
    downloadUrl: findActionLink($, /download/i),
    prev,
    next,
    episodes,
  };
}

export interface LandingInfo {
  /** True when the page is the promotional "landing / bookmark" page. */
  isLanding: boolean;
  /** "Go to the main LK21 site" link, if present. */
  homeUrl: string | null;
  /** "Klik untuk melanjutkan" link pointing at the real detail page. */
  continueUrl: string | null;
}

const LANDING_TEXT = /jangan tertipu link lk21|landing page resmi|bookmark url terbaru|ke halaman (utama )?lk21/i;
const LANDING_SKIP = /telegram|tiktok|insta|chord|speed|yasin/i;

/**
 * Some rotating domains (e.g. `d21.team`) only serve a promo page that links to
 * the real site. Detect that page and surface the real links so callers can
 * follow through instead of returning an empty detail document.
 */
export function parseLanding(html: string, base: string): LandingInfo {
  const $ = cheerio.load(html);
  const body = $("body").text().toLowerCase();
  const isLanding =
    $(".bookmark-url").length > 0 ||
    LANDING_TEXT.test(body) ||
    ($("a.cta-button").length >= 3 && $("article").length === 0);

  if (!isLanding) return { isLanding: false, homeUrl: null, continueUrl: null };

  let currentHost = "";
  try {
    currentHost = new URL(base).hostname;
  } catch {
    currentHost = "";
  }

  let homeUrl: string | null = null;
  let continueUrl: string | null = null;
  $("a.cta-button, .bookmark-url a").each((_, el) => {
    const $el = $(el);
    const abs = absUrl($el.attr("href"), base);
    if (!abs) return;
    const text = $el.text().toLowerCase();
    if (!continueUrl && /melanjutkan|lanjut/i.test(text)) continueUrl = abs;
    if (!homeUrl && !LANDING_SKIP.test(text)) {
      try {
        if (new URL(abs).hostname !== currentHost) homeUrl = abs;
      } catch {
        /* ignore */
      }
    }
  });

  return { isLanding, homeUrl, continueUrl };
}

export function parseTaxonomyLinks(html: string, base: string, kind: "genre" | "country"): TaxonomyItem[] {  const $ = cheerio.load(html);
  const items = new Map<string, TaxonomyItem>();
  $(`a[href*="/${kind}/"]`).each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const match = href.match(new RegExp(`/${kind}/([^/?#]+)`));
    if (!match) return;
    const slug = match[1];
    const name = $(el).text().replace(/\s+/g, " ").trim();
    if (!name || items.has(slug)) return;
    items.set(slug, {
      name,
      slug,
      url: absUrl(`/${kind}/${slug}`, base) ?? `/${kind}/${slug}`,
    });
  });
  return [...items.values()];
}

function hostOfUrl(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

const NAV_SERIES_LISTS = new Set(["latest", "populer", "rating", "release", "latest-series"]);

function navKind(href: string, pathname: string, moviesHost: string | null): NavItemKind {
  if (/^[a-z]+:\/\//i.test(href)) {
    const host = hostOfUrl(href);
    return moviesHost && host === moviesHost ? "movie" : "external";
  }
  if (pathname.startsWith("genre/")) return "genre";
  if (pathname.startsWith("country/")) return "country";
  if (pathname.startsWith("year/")) return "year";
  if (pathname.startsWith("series/") || NAV_SERIES_LISTS.has(pathname)) return "series";
  return "page";
}

/**
 * Parse the desktop navbar (`ul.navbar-nav`) into groups of filters. Each item
 * keeps its absolute URL plus a relative `path` (for internal tv9 filters) so
 * callers can feed it straight into the generic list scraper.
 */
export function parseNav(
  html: string,
  base: string,
  options: { moviesBase?: string } = {},
): NavGroup[] {
  const $ = cheerio.load(html);
  const moviesHost = options.moviesBase ? hostOfUrl(options.moviesBase) : null;
  const groups: NavGroup[] = [];

  $("ul.navbar-nav > li").each((_, li) => {
    const $li = $(li);
    const $toggle = $li.find("a.dropdown-toggle").first();
    if ($toggle.length === 0) return;

    const label = $toggle
      .clone()
      .children("i")
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (!label) return;

    const items: NavFilterItem[] = [];
    const seen = new Set<string>();
    $li.find(".dropdown-menu a").each((__, el) => {
      const href = $(el).attr("href") ?? "";
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (!href || href === "#" || !text) return;

      const url = absUrl(href, base);
      if (!url) return;
      let pathname = "";
      try {
        pathname = new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, "");
      } catch {
        return;
      }
      if (seen.has(url)) return;
      seen.add(url);
      items.push({
        label: text,
        url,
        path: pathname,
        slug: slugOf(url),
        kind: navKind(href, pathname, moviesHost),
      });
    });

    if (items.length > 0) groups.push({ label, items });
  });

  return groups;
}
