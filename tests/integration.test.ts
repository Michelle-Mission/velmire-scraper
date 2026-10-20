import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REDIS_PORT = 6399;
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;
const hasRedis =
  spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;

const suite = hasRedis ? describe : describe.skip;

function waitForTcp(port: number, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`service on port ${port} did not start`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}

function readFixture(name: string): string {
  return readFileSync(join(process.cwd(), "tests", "fixtures", name), "utf8");
}

suite("velmire-scraper v1 API", () => {
  let redis: ChildProcess | undefined;
  let mock: Server | undefined;
  let app: FastifyInstance | undefined;
  let mockBase = "";

  beforeAll(async () => {
    process.env.REDIS_URL = REDIS_URL;
    process.env.CLOUDSCRAPER_ENABLED = "false";
    process.env.CACHE_TTL_SECONDS = "30";

    redis = spawn(
      "redis-server",
      ["--port", String(REDIS_PORT), "--save", "", "--appendonly", "no"],
      { stdio: "ignore" },
    );
    await waitForTcp(REDIS_PORT);

    const homeHtml = readFixture("home.html");
    const listHtml = readFixture("list.html");
    const seriesHtml = readFixture("detail-series.html");
    const movieHtml = readFixture("detail-movie.html");
    const episodeHtml = readFixture("episode.html");
    const searchJson = readFixture("search.json");

    // A movie slug on tv9 redirects to a promo landing page that links to the
    // real detail page. The API must follow that link once.
    const landingHtml =
      `<!doctype html><html><head><title>Jangan Tertipu Link Lk21 Abal-Abal</title></head><body>` +
      `<a class="cta-button" href="https://www.lk21.de/">KE HALAMAN UTAMA LK21</a>` +
      `<a class="cta-button" href="${mockBase}/kate-2026">KLIK UNTUK MELANJUTKAN</a>` +
      `<script>a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'</script>` +
      `</body></html>`;

    const listPaths = (path: string): boolean =>
      path.startsWith("/genre/") ||
      path.startsWith("/country/") ||
      path.startsWith("/year/") ||
      path.startsWith("/series/") ||
      path.startsWith("/latest/") ||
      path.startsWith("/populer/") ||
      path.startsWith("/rating/") ||
      path.startsWith("/release/") ||
      path.startsWith("/top-movie-today/") ||
      path.startsWith("/latest-series/");

    const send = (res: ServerResponse, body: string, type = "text/html; charset=utf-8"): void => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };

    mock = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method === "POST" && path === "/api.php") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const id = new URLSearchParams(body).get("id");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ embedUrl: `${mockBase}/embed-${id}` }));
        });
        return;
      }
      if (path === "/embed-open") return send(res, "<html>open</html>");
      if (path === "/embed-locked") {
        res.writeHead(200, {
          "content-type": "text/html",
          "content-security-policy":
            "frame-ancestors 'self' https://videonode.de https://*.nontondrama.my",
        });
        res.end("<html>locked</html>");
        return;
      }
      if (path === "/playlist.m3u8") {
        return send(
          res,
          "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg0.pict\n#EXTINF:10.0,\nsub.m3u8\n",
          "application/vnd.apple.mpegurl",
        );
      }
      if (path === "/seg0.pict") {
        res.writeHead(200, { "content-type": "video/mp2t", "content-length": "8" });
        res.end(Buffer.alloc(8, 0x47));
        return;
      }
      if (path === "/") return send(res, homeHtml);
      if (path === "/search.php") return send(res, searchJson, "application/json");
      if (path === "/doctor-x-age-white-mafia-2026") return send(res, seriesHtml);
      if (path === "/doctor-x-age-white-mafia-2026-episode-1") return send(res, episodeHtml);
      if (path === "/kate-2026") return send(res, movieHtml);
      if (path === "/promo-movie-2026") return send(res, landingHtml);
      if (listPaths(path)) return send(res, listHtml);
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    await new Promise<void>((resolve) => mock?.listen(0, "127.0.0.1", resolve));
    const mockPort = (mock.address() as AddressInfo).port;
    mockBase = `http://127.0.0.1:${mockPort}`;

    process.env.LK21_URL = mockBase;
    process.env.LK21_MOVIES_URL = mockBase;
    process.env.LK21_SEARCH_URL = `${mockBase}/`;
    process.env.LK21_POSTER_URL = `${mockBase}/uploads/`;
    process.env.ALLOWED_HOSTS = "127.0.0.1";
    process.env.ALLOWED_PORTS = String(mockPort);

    const { buildApp } = await import("../src/api/app");
    app = await buildApp();
    await app.ready();
  }, 30000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    if (mock) await new Promise<void>((resolve) => mock?.close(() => resolve()));
    if (redis) redis.kill("SIGKILL");
  }, 30000);

  it("reports health", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ redis: "ok", cloudscraper: "disabled" });
  });

  it("serves the web UI at the root", async () => {
    const res = await app!.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("LK21");
  });

  it("returns the home sections", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/home" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sections).toHaveLength(2);
    expect(body.sections[0].title).toBe("Series Terbaru");
  });

  it("lists the latest movies and reports pagination", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/latest?page=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ page: 1, totalPages: 5, count: 2 });
    expect(body.items[0].slug).toBe("doctor-x-age-white-mafia-2026");
  });

  it("filters by genre", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/genre/action" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
  });

  it("scrapes the navbar filters", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/filters" });
    expect(res.statusCode).toBe(200);
    const groups = res.json().groups;
    expect(groups.map((group: { label: string }) => group.label)).toEqual([
      "Genre",
      "Lk21",
      "Series",
    ]);
    expect(groups[0].items[0]).toMatchObject({ label: "Action", kind: "genre" });
  });

  it("lists a series sub-filter", async () => {
    const ok = await app!.inject({ method: "GET", url: "/v1/series/ongoing" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items).toHaveLength(2);

    const bad = await app!.inject({ method: "GET", url: "/v1/series/bogus" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_filter");
  });

  it("lists any supported navbar filter path", async () => {
    const ok = await app!.inject({ method: "GET", url: "/v1/filter?path=year/2026" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items).toHaveLength(2);

    const list = await app!.inject({ method: "GET", url: "/v1/filter?path=populer" });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(2);

    const missing = await app!.inject({ method: "GET", url: "/v1/filter" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("missing_path");

    const invalid = await app!.inject({ method: "GET", url: "/v1/filter?path=../../etc" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_filter");

    const series = await app!.inject({ method: "GET", url: "/v1/filter?path=series/bogus" });
    expect(series.statusCode).toBe(400);
    expect(series.json().error).toBe("invalid_filter");
  });

  it("lists movies from the movie portal", async () => {
    const ok = await app!.inject({ method: "GET", url: "/v1/movies/latest" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items).toHaveLength(2);

    const bad = await app!.inject({ method: "GET", url: "/v1/movies/bogus" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_kind");
  });

  it("validates the year path parameter", async () => {
    const ok = await app!.inject({ method: "GET", url: "/v1/year/2026" });
    expect(ok.statusCode).toBe(200);
    const bad = await app!.inject({ method: "GET", url: "/v1/year/20xx" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_year");
  });

  it("searches through the JSON endpoint", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/search?q=doctor" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPages).toBe(2);
    expect(body.items[0]).toMatchObject({
      slug: "doctor-x-age-white-mafia-2026",
      type: "series",
      poster: `${mockBase}/uploads/2026/10/film-doctor-x-age-white-mafia-lk21.jpg`,
    });
    expect(body.items[1]).toMatchObject({ slug: "kate-2026", type: "movie", quality: "WEBDL" });
  });

  it("requires a search query", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/search" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_query");
  });

  it("returns a series detail by slug", async () => {
    const res = await app!.inject({
      method: "GET",
      url: "/v1/movie?slug=doctor-x-age-white-mafia-2026",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe("series");
    expect(body.seasons[0].episodes).toHaveLength(4);
  });

  it("returns a movie detail by url", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/v1/movie?url=${encodeURIComponent(`${mockBase}/kate-2026`)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe("movie");
    expect(body.streams).toHaveLength(3);
    expect(body.streams.map((s: { server: string }) => s.server)).toContain("turbovip");
  });

  it("follows a promo landing page to the movie detail", async () => {
    const res = await app!.inject({
      method: "GET",
      url: "/v1/movie?slug=promo-movie-2026",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe("movie");
    expect(body.streams).toHaveLength(3);
  });

  it("resolves a stream and flags embeddable players", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/v1/stream?url=${encodeURIComponent(`${mockBase}/iframe3/p2p/open`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      server: "p2p",
      embed: `${mockBase}/embed-open`,
      embeddable: true,
    });
  });

  it("flags players that block embedding", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/v1/stream?url=${encodeURIComponent(`${mockBase}/iframe3/cast/locked`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ server: "cast", embeddable: false });
  });

  it("requires a url for the stream resolver", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/stream" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_url");
  });

  it("proxies and rewrites an HLS playlist through /v1/stream", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/v1/stream?proxy=1&url=${encodeURIComponent(`${mockBase}/playlist.m3u8`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    const proxied = `/v1/stream?proxy=1&url=${encodeURIComponent(`${mockBase}/seg0.pict`)}`;
    expect(res.body).toContain(proxied);
    expect(res.body).toContain(
      `/v1/stream?proxy=1&url=${encodeURIComponent(`${mockBase}/sub.m3u8`)}`,
    );
  });

  it("proxies media segments through the same endpoint", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/v1/stream?proxy=1&url=${encodeURIComponent(`${mockBase}/seg0.pict`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp2t");
    expect(res.rawPayload.length).toBe(8);
  });

  it("auto-detects the proxy role without an explicit flag", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/v1/stream?url=${encodeURIComponent(`${mockBase}/seg0.pict`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp2t");
  });

  it("reports a fetch failure for an unreachable media source", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/v1/stream?proxy=1&url=${encodeURIComponent(`${mockBase}/missing.pict`)}`,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("media_fetch_failed");
  });

  it("returns an episode with its streams", async () => {
    const res = await app!.inject({
      method: "GET",
      url: "/v1/episode?slug=doctor-x-age-white-mafia-2026-episode-1",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaultStream).toBe("https://stream.example/embed/p2p");
    expect(body.next.slug).toBe("doctor-x-age-white-mafia-2026-episode-2");
  });

  it("returns 404 when the content slug does not exist", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/movie?slug=missing-2026" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("rejects a series slug on the episode endpoint", async () => {
    const res = await app!.inject({
      method: "GET",
      url: "/v1/episode?slug=doctor-x-age-white-mafia-2026",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_an_episode");
  });

  it("requires a reference for detail requests", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/movie" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_reference");
  });

  it("lists genres and countries", async () => {
    const genres = await app!.inject({ method: "GET", url: "/v1/genres" });
    expect(genres.statusCode).toBe(200);
    expect(genres.json()).toHaveLength(4);

    const countries = await app!.inject({ method: "GET", url: "/v1/countries" });
    expect(countries.statusCode).toBe(200);
    expect(countries.json()).toHaveLength(2);
  });

  it("returns a structured 404 for unknown API routes", async () => {
    const res = await app!.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});
