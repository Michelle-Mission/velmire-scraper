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
  next: EpisodeLink | null;
  episodes: EpisodeLink[];
}

export interface TaxonomyItem {
  name: string;
  slug: string;
  url: string;
}

export interface FetchInfo {
  engine: "direct" | "cloudscraper";
  statusCode: number;
  finalUrl: string;
}
