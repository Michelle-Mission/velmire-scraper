import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { respond, strParam } from "../respond";
import {
  getByCountry,
  getByGenre,
  getByYear,
  getEpisode,
  getFilter,
  getFilters,
  getGenres,
  getCountries,
  getHome,
  getList,
  getMovie,
  getMovieList,
  getSeriesFilter,
  MOVIE_LIST_KINDS,
  normalizeListOptions,
  parseContentType,
  search,
  SERIES_FILTERS,
  type ListKind,
  type MovieListKind,
} from "../../scraper/lk21/service";

function intParam(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function listQuery(query: unknown): ReturnType<typeof normalizeListOptions> {
  const q = (query ?? {}) as Record<string, unknown>;
  return normalizeListOptions({
    page: intParam(q.page),
    pages: intParam(q.pages),
    limit: intParam(q.limit),
  });
}

export async function registerV1Routes(app: FastifyInstance): Promise<void> {
  const listHandler = (kind: ListKind) =>
    async (request: FastifyRequest, reply: FastifyReply) =>
      respond(reply, () => getList(app.redis, kind, listQuery(request.query)));

  app.get("/v1/home", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const limit = intParam(q.limit) ?? 0;
    return respond(reply, () => getHome(app.redis, limit));
  });

  app.get("/v1/latest", listHandler("latest"));
  app.get("/v1/popular", listHandler("popular"));
  app.get("/v1/rating", listHandler("rating"));
  app.get("/v1/release", listHandler("release"));
  app.get("/v1/series", listHandler("series"));

  app.get("/v1/series/:filter", async (request, reply) => {
    const { filter } = request.params as { filter: string };
    if (!(SERIES_FILTERS as readonly string[]).includes(filter)) {
      return reply.code(400).send({
        error: "invalid_filter",
        message: `Filter series tidak dikenal; pilih ${SERIES_FILTERS.join(", ")}`,
      });
    }
    return respond(reply, () => getSeriesFilter(app.redis, filter, listQuery(request.query)));
  });

  app.get("/v1/filters", async (_request, reply) => {
    return respond(reply, () => getFilters(app.redis));
  });

  app.get("/v1/filter", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const path = strParam(q.path);
    if (!path) {
      return reply
        .code(400)
        .send({ error: "missing_path", message: "Query parameter `path` is required" });
    }
    return respond(reply, () => getFilter(app.redis, path, listQuery(q)));
  });

  app.get("/v1/movies/:kind", async (request, reply) => {
    const { kind } = request.params as { kind: string };
    if (!(MOVIE_LIST_KINDS as readonly string[]).includes(kind)) {
      return reply.code(400).send({
        error: "invalid_kind",
        message: `Jenis daftar film tidak dikenal; pilih ${MOVIE_LIST_KINDS.join(", ")}`,
      });
    }
    return respond(reply, () =>
      getMovieList(app.redis, kind as MovieListKind, listQuery(request.query)),
    );
  });

  app.get("/v1/search", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const query = strParam(q.q);
    if (!query) {
      return reply
        .code(400)
        .send({ error: "missing_query", message: "Query parameter `q` is required" });
    }
    return respond(reply, () =>
      search(app.redis, query, intParam(q.page) ?? 1, intParam(q.limit) ?? 0),
    );
  });

  app.get("/v1/genre/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!slug) {
      return reply.code(400).send({ error: "missing_slug", message: "Genre slug is required" });
    }
    const q = (request.query ?? {}) as Record<string, unknown>;
    return respond(reply, () =>
      getByGenre(app.redis, slug, parseContentType(strParam(q.type)), listQuery(q)),
    );
  });

  app.get("/v1/country/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!slug) {
      return reply.code(400).send({ error: "missing_slug", message: "Country slug is required" });
    }
    const q = (request.query ?? {}) as Record<string, unknown>;
    return respond(reply, () =>
      getByCountry(app.redis, slug, parseContentType(strParam(q.type)), listQuery(q)),
    );
  });

  app.get("/v1/year/:year", async (request, reply) => {
    const { year } = request.params as { year: string };
    if (!/^\d{4}$/.test(year ?? "")) {
      return reply
        .code(400)
        .send({ error: "invalid_year", message: "Year must be a 4-digit number" });
    }
    const q = (request.query ?? {}) as Record<string, unknown>;
    return respond(reply, () =>
      getByYear(app.redis, year, parseContentType(strParam(q.type)), listQuery(q)),
    );
  });

  app.get("/v1/movie", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const url = strParam(q.url);
    const slug = strParam(q.slug);
    if (!url && !slug) {
      return reply
        .code(400)
        .send({ error: "missing_reference", message: "Provide either `url` or `slug`" });
    }
    return respond(reply, () => getMovie(app.redis, { url, slug }));
  });

  app.get("/v1/episode", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const url = strParam(q.url);
    const slug = strParam(q.slug);
    if (!url && !slug) {
      return reply
        .code(400)
        .send({ error: "missing_reference", message: "Provide either `url` or `slug`" });
    }
    return respond(reply, () => getEpisode(app.redis, { url, slug }));
  });

  app.get("/v1/genres", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    return respond(reply, () => getGenres(app.redis, parseContentType(strParam(q.type))));
  });

  app.get("/v1/countries", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    return respond(reply, () => getCountries(app.redis, parseContentType(strParam(q.type))));
  });
}
