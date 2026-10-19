import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseDetail,
  parseEpisode,
  parseHome,
  parseLanding,
  parseList,
  parseTaxonomyLinks,
} from "../src/lk21/parsers";

const BASE = "https://tv9.nontondrama.my";

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "tests", "fixtures", name), "utf8");
}

describe("parseList", () => {
  const result = parseList(fixture("list.html"), BASE);

  it("reads the total page count from the header", () => {
    expect(result.totalPages).toBe(5);
  });

  it("parses every card", () => {
    expect(result.items).toHaveLength(2);
  });

  it("parses a series card", () => {
    expect(result.items[0]).toMatchObject({
      title: "Doctor X: Age of the White Mafia",
      slug: "doctor-x-age-white-mafia-2026",
      url: `${BASE}/doctor-x-age-white-mafia-2026`,
      type: "series",
      poster: "https://poster.assetsy.de/film-doctor-x.jpg",
      rating: 9.5,
      year: 2026,
      episode: 4,
      season: 1,
      duration: null,
      genres: ["Drama", "Mystery"],
      complete: false,
    });
  });

  it("parses a movie card", () => {
    expect(result.items[1]).toMatchObject({
      title: "My Movie",
      slug: "my-movie-2020",
      type: "movie",
      duration: "01:52",
      episode: null,
      season: null,
      genres: ["Action"],
    });
  });

  it("reads rating and quality from plain card markup", () => {
    const html = `<div class="gallery-grid"><article itemscope itemtype="https://schema.org/Movie">
      <figure><a href="/kumanthong-that-son-tam-linh-2019" itemprop="url">
        <div class="poster">
          <span class="rating"><i class="fa-star" aria-hidden="true"></i> 5.5 </span>
          <span class="year" itemprop="datePublished">2019</span>
          <span class="label label-HD">HD</span>
          <span class="duration" itemprop="duration" content="PT1M40S">01:40</span>
          <img alt="Kumathong: The Untold Story (2019)" src="https://poster.assetsy.de/kumathong.jpg" />
        </div>
        <figcaption><h3 class="poster-title" itemprop="name">Kumathong: The Untold Story</h3></figcaption>
      </a></figure></article></div>`;
    const parsed = parseList(html, BASE);
    expect(parsed.items[0]).toMatchObject({
      title: "Kumathong: The Untold Story",
      rating: 5.5,
      year: 2019,
      quality: "HD",
      duration: "01:40",
    });
  });

  it("resolves slugs from `?page=` series links", () => {
    const html = `<div class="gallery-grid"><article itemscope itemtype="https://schema.org/Movie">
      <figure><a href="/nontondrama?page=the-glory-2022" itemprop="url">
        <div class="poster"><span class="episode ">EPS<strong>16</strong></span>
        <img alt="The Glory (2022)" src="https://poster.assetsy.de/the-glory.jpg" /></div>
        <figcaption><h3 class="poster-title" itemprop="name">The Glory</h3></figcaption>
      </a></figure></article></div>`;
    const parsed = parseList(html, BASE);
    expect(parsed.items[0]).toMatchObject({
      slug: "the-glory-2022",
      url: `${BASE}/the-glory-2022`,
      type: "series",
    });
  });
});

describe("parseHome", () => {
  const result = parseHome(fixture("home.html"), BASE);

  it("collects each widget as a section", () => {
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toMatchObject({
      title: "Series Terbaru",
      seeAll: `${BASE}/latest-series`,
      type: "latest-series",
      count: 1,
    });
    expect(result.sections[1]).toMatchObject({
      title: "Film Terbaru",
      type: "latest",
    });
    expect(result.sections[0].items[0].slug).toBe("doctor-x-age-white-mafia-2026");
  });
});

describe("parseDetail (series)", () => {
  const url = `${BASE}/doctor-x-age-white-mafia-2026`;
  const result = parseDetail(fixture("detail-series.html"), url, BASE);

  it("detects a series with its seasons", () => {
    expect(result.type).toBe("series");
    expect(result.seasons).toHaveLength(1);
    expect(result.seasons[0].season).toBe(1);
    expect(result.seasons[0].episodes).toHaveLength(4);
    expect(result.seasons[0].episodes[0]).toMatchObject({
      season: 1,
      episode: 1,
      slug: "doctor-x-age-white-mafia-2026-episode-1",
      url: `${BASE}/doctor-x-age-white-mafia-2026-episode-1`,
    });
  });

  it("extracts metadata and taxonomy", () => {
    expect(result).toMatchObject({
      slug: "doctor-x-age-white-mafia-2026",
      rating: 9.5,
      year: 2026,
      status: "Ongoing",
      genres: ["Drama", "Mystery"],
      countries: ["South Korea"],
      totalSeasons: 1,
      totalEpisodes: 4,
    });
    expect(result.synopsis).toContain("genius surgeon");
    expect(result.playFirst).toBe(`${BASE}/doctor-x-age-white-mafia-2026-episode-1`);
    expect(result.playLatest).toBe(`${BASE}/doctor-x-age-white-mafia-2026-episode-4`);
  });
});

describe("parseDetail (movie)", () => {
  const url = `${BASE}/kate-2026`;
  const result = parseDetail(fixture("detail-movie.html"), url, BASE);

  it("detects a movie with streams", () => {
    expect(result.type).toBe("movie");
    expect(result.seasons).toHaveLength(0);
    expect(result.quality).toBe("WEBDL");
    expect(result.resolution).toBe("1080p");
    expect(result.duration).toBe("01:02");
    expect(result.genres).toEqual(["Comedy"]);
    expect(result.countries).toEqual(["United States"]);
    expect(result.streams).toEqual([
      { server: "p2p", url: "https://stream.example/p2p" },
      { server: "cast", url: "https://stream.example/cast" },
    ]);
    expect(result.downloadUrl).toBe("https://dadadidi.de/kate-2026/");
    expect(result.playFirst).toBeNull();
  });
});

describe("parseEpisode", () => {
  const url = `${BASE}/doctor-x-age-white-mafia-2026-episode-1`;
  const result = parseEpisode(fixture("episode.html"), url, BASE);

  it("exposes the default stream and servers", () => {
    expect(result.defaultStream).toBe("https://stream.example/embed/p2p");
    expect(result.streams).toHaveLength(2);
    expect(result.downloadUrl).toBe(
      "https://dadadidi.de/doctor-x-age-white-mafia-2026-episode-1/",
    );
  });

  it("links back to its series and next episode", () => {
    expect(result.series).toEqual({
      title: "Doctor X: Age of the White Mafia",
      slug: "doctor-x-age-white-mafia-2026",
    });
    expect(result.season).toBe(1);
    expect(result.episode).toBe(1);
    expect(result.next).toMatchObject({
      season: 1,
      episode: 2,
      slug: "doctor-x-age-white-mafia-2026-episode-2",
      url: `${BASE}/doctor-x-age-white-mafia-2026-episode-2`,
    });
    expect(result.episodes).toHaveLength(2);
  });
});

describe("parseTaxonomyLinks", () => {
  const html = fixture("home.html");

  it("collects unique genre links", () => {
    expect(parseTaxonomyLinks(html, BASE, "genre")).toEqual([
      { name: "Action", slug: "action", url: `${BASE}/genre/action` },
      { name: "Drama", slug: "drama", url: `${BASE}/genre/drama` },
      { name: "Comedy", slug: "comedy", url: `${BASE}/genre/comedy` },
    ]);
  });

  it("collects unique country links", () => {
    expect(parseTaxonomyLinks(html, BASE, "country")).toEqual([
      { name: "South Korea", slug: "south-korea", url: `${BASE}/country/south-korea` },
      { name: "United States", slug: "united-states", url: `${BASE}/country/united-states` },
    ]);
  });
});

describe("parseLanding", () => {
  it("detects the promo landing page and finds the real links", () => {
    const html = `
      <html><body>
        <h1>Jangan Tertipu Link Lk21 Abal-Abal</h1>
        <a class="cta-button" href="https://www.lk21.de">KE HALAMAN UTAMA LK21</a>
        <a class="cta-button" href="https://www.lk21.de/kumanthong-2019">KLIK UNTUK MELANJUTKAN</a>
        <a class="cta-button" href="https://t.me/lk21">LK21 ON TELEGRAM</a>
      </body></html>`;

    const result = parseLanding(html, "https://d21.team/kumanthong-2019");

    expect(result.isLanding).toBe(true);
    expect(result.homeUrl).toBe("https://www.lk21.de/");
    expect(result.continueUrl).toBe("https://www.lk21.de/kumanthong-2019");
  });

  it("resolves a relative continue link and ignores same-host links", () => {
    const html = `
      <html><body>
        <div class="bookmark-url">
          <a href="/badak-2025">KLIK UNTUK MELANJUTKAN</a>
          <a href="https://d21.team/other">Bookmark URL</a>
        </div>
      </body></html>`;

    const result = parseLanding(html, "https://d21.team/");

    expect(result.isLanding).toBe(true);
    expect(result.continueUrl).toBe("https://d21.team/badak-2025");
    expect(result.homeUrl).toBeNull();
  });

  it("returns isLanding=false for a normal detail page", () => {
    const result = parseLanding(fixture("detail-movie.html"), BASE);
    expect(result.isLanding).toBe(false);
    expect(result.homeUrl).toBeNull();
    expect(result.continueUrl).toBeNull();
  });
});
