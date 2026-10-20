export type ContentType = "movie" | "series";

export interface ListItem {
  title: string;
  slug: string;
  url: string;
  type: ContentType;
  poster: string | null;
  rating: number | null;
  year: number | null;
  episode: number | null;
  season: number | null;
  duration: string | null;
  quality: string | null;
  genres: string[];
  complete: boolean;
}

export interface ListResult {
  page: number;
  pages: number;
  totalPages: number | null;
  count: number;
  items: ListItem[];
}

export interface HomeSection {
  title: string;
  seeAll: string | null;
  type: string | null;
  count: number;
  items: ListItem[];
}

export interface HomeResult {
  sections: HomeSection[];
}

export interface StreamSource {
  server: string;
  url: string;
}

export interface EpisodeLink {
  season: number;
  episode: number;
  title: string;
  slug: string;
  url: string;
}

export interface SeasonGroup {
  season: number;
  episodes: EpisodeLink[];
}

export interface DetailResult {
  title: string;
  slug: string;
  url: string;
  type: ContentType;
  poster: string | null;
  rating: number | null;
  year: number | null;
  duration: string | null;
  quality: string | null;
  resolution: string | null;
  status: string | null;
  synopsis: string | null;
  trailer: string | null;
  genres: string[];
  countries: string[];
  directors: string[];
  casts: string[];
  downloadUrl: string | null;
  streams: StreamSource[];
  playFirst: string | null;
  playLatest: string | null;
  totalSeasons: number | null;
  totalEpisodes: number | null;
  seasons: SeasonGroup[];
}

export interface EpisodeResult {
  title: string;
  slug: string;
  url: string;
  poster: string | null;
  year: number | null;
  series: { title: string; slug: string } | null;
  season: number | null;
  episode: number | null;
  streams: StreamSource[];
  defaultStream: string | null;
  downloadUrl: string | null;
  prev: EpisodeLink | null;
  next: EpisodeLink | null;
  episodes: EpisodeLink[];
}

export interface TaxonomyItem {
  name: string;
  slug: string;
  url: string;
}

export type NavItemKind = "genre" | "country" | "year" | "series" | "movie" | "page" | "external";

export interface NavFilterItem {
  label: string;
  /** Absolute URL on the source that owns the filter (tv9 or the movie portal). */
  url: string;
  /** Path relative to its owner, without a leading slash (empty for external links). */
  path: string;
  slug: string;
  kind: NavItemKind;
}

export interface NavGroup {
  label: string;
  items: NavFilterItem[];
}

export interface FiltersResult {
  groups: NavGroup[];
}

export interface FetchInfo {
  engine: "direct" | "cloudscraper";
  statusCode: number;
  finalUrl: string;
}
