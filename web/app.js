/* global bootstrap */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path) {
  const response = await fetch(path);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.error || `HTTP ${response.status}`);
  }
  return body;
}

function badge(text, variant) {
  return h("span", { class: `badge text-bg-${variant}`, text });
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------
const browseState = { kind: "home", arg: "", page: 1, limit: 24, totalPages: null };
const browseResults = document.getElementById("browse-results");
const browseTitle = document.getElementById("browse-title");
const siteType = document.getElementById("site-type");
const pager = document.getElementById("pager");
const pageInfo = document.getElementById("page-info");
const pagePrev = document.getElementById("page-prev");
const pageNext = document.getElementById("page-next");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");

const TITLES = {
  home: "Beranda",
  latest: "Film terbaru",
  popular: "Film populer",
  rating: "Rating tertinggi",
  release: "Rilis terbaru",
  series: "Series terbaru",
  genres: "Daftar genre",
  countries: "Daftar negara",
  search: "Hasil pencarian",
  genre: "Genre",
  country: "Negara",
  year: "Tahun",
};

/** Endpoints whose listing depends on the movie/series site toggle. */
const SITE_TYPES = new Set(["genre", "country", "year"]);

function browseUrl() {
  const { kind, arg, page, limit } = browseState;
  const type = SITE_TYPES.has(kind) ? `&type=${siteType.value}` : "";
  switch (kind) {
    case "home":
      return `/v1/home?limit=${limit}`;
    case "genres":
    case "countries":
      return `/v1/${kind}${type.replace("&", "?")}`;
    case "search":
      return `/v1/search?q=${encodeURIComponent(arg)}&page=${page}&limit=${limit}`;
    case "genre":
    case "country":
    case "year":
      return `/v1/${kind}/${encodeURIComponent(arg)}?page=${page}&limit=${limit}${type}`;
    default:
      return `/v1/${kind}?page=${page}&limit=${limit}`;
  }
}

function spinner() {
  return h(
    "div",
    { class: "d-flex justify-content-center py-5" },
    h("div", { class: "spinner-border text-primary", role: "status" }, h("span", { class: "visually-hidden", text: "memuat" })),
  );
}

function renderCard(item) {
  const media = h("div", { class: "poster-media" });
  if (item.poster) {
    media.append(h("img", { src: item.poster, alt: item.title || "", loading: "lazy" }));
  } else {
    media.append(h("div", { class: "poster-empty", text: "no poster" }));
  }
  media.append(badge(item.type === "series" ? "series" : "movie", item.type === "series" ? "info" : "warning"));

  const bits = [];
  if (item.year) bits.push(item.year);
  if (item.rating) bits.push(`★ ${item.rating}`);
  if (item.season) bits.push(`S${item.season}`);
  if (item.episode) bits.push(`EPS ${item.episode}`);
  if (item.duration) bits.push(item.duration);

  const card = h(
    "article",
    { class: "poster-card", tabindex: "0", role: "button" },
    media,
    h(
      "div",
      { class: "poster-body" },
      h("div", { class: "poster-title", text: item.title || item.slug || "(untitled)" }),
      bits.length ? h("div", { class: "poster-meta", text: bits.join(" · ") }) : null,
      item.genres && item.genres.length ? h("div", { class: "poster-genres", text: item.genres.join(", ") }) : null,
    ),
  );

  const open = () => openDetail(item.slug || item.url, item.title);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  return card;
}

function renderTaxonomy(items, singular) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return h("p", { class: "text-secondary", text: "Tidak ada data." });
  const wrap = h("div", { class: "d-flex flex-wrap gap-2" });
  for (const item of list) {
    wrap.append(
      h("button", {
        class: "btn btn-sm btn-outline-info",
        type: "button",
        text: item.name || item.slug,
        onclick: () => selectBrowse(singular, item.slug),
      }),
    );
  }
  return wrap;
}

function posterGrid(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = item.slug || item.url || item.title;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    unique.push(item);
  }
  const row = h("div", { class: "row row-cols-2 row-cols-sm-3 row-cols-md-4 row-cols-lg-6 g-3" });
  for (const item of unique.slice(0, 90)) {
    row.append(h("div", { class: "col" }, renderCard(item)));
  }
  return row;
}

function renderBrowse(data) {
  browseResults.replaceChildren();

  if (browseState.kind === "genres" || browseState.kind === "countries") {
    browseResults.append(renderTaxonomy(data, browseState.kind === "genres" ? "genre" : "country"));
    return;
  }

  if (Array.isArray(data.sections)) {
    for (const section of data.sections) {
      if (!section.items || section.items.length === 0) continue;
      browseResults.append(
        h("h6", { class: "section-head", text: section.title || "Section" }),
        posterGrid(section.items),
      );
    }
    return;
  }

  if (Array.isArray(data) && data[0] && (data[0].slug || data[0].poster)) {
    browseResults.append(posterGrid(data));
    return;
  }

  if (Array.isArray(data.items) && data.items.length > 0) {
    browseResults.append(posterGrid(data.items));
    return;
  }

  browseResults.append(h("p", { class: "text-secondary", text: "Tidak ada hasil." }));
}

async function runBrowse() {
  browseResults.replaceChildren(spinner());
  const base = TITLES[browseState.kind] ?? "Hasil";
  browseTitle.textContent = browseState.arg ? `${base}: ${browseState.arg}` : base;
  pager.classList.add("d-none");
  try {
    const data = await api(browseUrl());
    renderBrowse(data);
    if (data && Array.isArray(data.items)) {
      browseState.totalPages = data.totalPages ?? null;
      pageInfo.textContent = browseState.totalPages ? `hal. ${data.page} / ${browseState.totalPages}` : `hal. ${data.page}`;
      pager.classList.remove("d-none");
      pagePrev.classList.toggle("disabled", browseState.page <= 1);
      const hasNext = browseState.totalPages
        ? browseState.page < browseState.totalPages
        : (data.count ?? data.items.length) >= browseState.limit;
      pageNext.classList.toggle("disabled", !hasNext);
    }
  } catch (error) {
    browseResults.replaceChildren(h("div", { class: "alert alert-danger", text: error.message }));
  }
}

function selectBrowse(kind, arg = "") {
  browseState.kind = kind;
  browseState.arg = arg;
  browseState.page = 1;
  void runBrowse();
}

document.getElementById("quick-bar").addEventListener("click", (event) => {
  const button = event.target.closest("[data-quick]");
  if (button) selectBrowse(button.dataset.quick);
});

siteType.addEventListener("change", () => {
  if (SITE_TYPES.has(browseState.kind)) {
    browseState.page = 1;
    void runBrowse();
  }
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (query) selectBrowse("search", query);
});

pagePrev.addEventListener("click", () => {
  if (browseState.page > 1) {
    browseState.page -= 1;
    void runBrowse();
  }
});
pageNext.addEventListener("click", () => {
  browseState.page += 1;
  void runBrowse();
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
const detailModal = new bootstrap.Modal("#detailModal");
const detailTitle = document.getElementById("detail-title");
const detailBody = document.getElementById("detail-body");
const watchModal = new bootstrap.Modal("#watchModal");
const watchTitle = document.getElementById("watch-title");
const watchFrame = document.getElementById("watch-frame");
const watchStage = document.getElementById("watch-stage");
const watchVideoStage = document.getElementById("watch-video-stage");
const watchVideo = document.getElementById("watch-video");
const watchMessage = document.getElementById("watch-message");
const watchNote = document.getElementById("watch-note");
const watchExternal = document.getElementById("watch-external");

const streamCache = new Map();
let hlsInstance = null;
let watchEmbedOrigin = "";

// The cast/Byse embed page asks its parent for context before loading the
// player. Answer with an allow-listed host so the provider does not reject
// the iframe with "embedding from this domain is not allowed".
window.addEventListener("message", (event) => {
  const frameWindow = watchFrame.contentWindow;
  if (!frameWindow || event.source !== frameWindow) return;
  if (watchEmbedOrigin !== "https://mfw09.org") return;
  const data = event.data;
  if (!data || data.type !== "moonwalk-embed-context-request") return;
  frameWindow.postMessage(
    {
      type: "moonwalk-embed-context",
      host: "videonode.de",
      referrer: "https://videonode.de/",
      parentFrame: "https://videonode.de/",
    },
    watchEmbedOrigin || "https://mfw09.org",
  );
});

async function getStreamInfo(url) {
  if (streamCache.has(url)) return streamCache.get(url);
  try {
    const info = await api(`/v1/stream?url=${encodeURIComponent(url)}`);
    streamCache.set(url, info);
    return info;
  } catch (error) {
    const failed = { error: error.message };
    streamCache.set(url, failed);
    return failed;
  }
}

function resetWatch() {
  watchFrame.src = "about:blank";
  watchEmbedOrigin = "";
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  watchVideo.pause();
  watchVideo.removeAttribute("src");
  watchVideo.load();
  watchStage.classList.add("d-none");
  watchVideoStage.classList.add("d-none");
  watchMessage.classList.add("d-none");
  watchMessage.replaceChildren();
}

function showWatchMessage(node) {
  resetWatch();
  watchMessage.classList.remove("d-none");
  watchMessage.replaceChildren(...(Array.isArray(node) ? node : [node]));
}

function playHls(info) {
  const source = info.hls;
  watchStage.classList.add("d-none");
  watchVideoStage.classList.remove("d-none");
  watchNote.textContent = `server: ${info.server} · hls`;
  watchExternal.href = info.hls;
  if (window.Hls && window.Hls.isSupported()) {
    hlsInstance = new window.Hls({ maxBufferLength: 30 });
    hlsInstance.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) {
        showWatchMessage(
          h("div", { class: "alert alert-danger d-inline-block text-start mb-0" },
            h("strong", { text: "Gagal memutar stream." }),
            h("div", { class: "small", text: data.details || "Kesalahan pemutaran." }),
          ),
        );
      }
    });
    hlsInstance.loadSource(source);
    hlsInstance.attachMedia(watchVideo);
    watchVideo.play().catch(() => {});
  } else if (watchVideo.canPlayType("application/vnd.apple.mpegurl")) {
    watchVideo.src = source;
    watchVideo.play().catch(() => {});
  } else {
    showWatchMessage(
      h("div", { class: "alert alert-warning d-inline-block text-start mb-0" },
        h("strong", { text: "Browser tidak mendukung pemutaran HLS." }),
      ),
    );
  }
}

function embedWatch(info) {
  watchEmbedOrigin = new URL(info.embed).origin;
  watchVideoStage.classList.add("d-none");
  watchStage.classList.remove("d-none");
  watchFrame.src = info.embed;
  watchExternal.href = info.embed;
  watchNote.textContent = `server: ${info.server}`;
}

async function playFallback(title, stream, streams) {
  if (stream.server !== "turbovip") return false;
  for (const alternative of streams) {
    if (alternative.url === stream.url || alternative.server === "turbovip") continue;
    const info = await getStreamInfo(alternative.url);
    if (info && (info.hls || info.embeddable)) {
      await startWatch(title, alternative, streams);
      watchNote.textContent = `server: ${alternative.server} · turbovip tidak tersedia`;
      return true;
    }
  }
  return false;
}

async function startWatch(title, stream, streams = []) {
  watchTitle.textContent = `${title} — ${stream.server}`;
  watchNote.textContent = "menyiapkan…";
  watchExternal.href = stream.url;
  resetWatch();
  watchModal.show();

  const info = await getStreamInfo(stream.url);
  if (info && info.hls) {
    playHls(info);
    return;
  }
  if (info && info.embeddable) {
    embedWatch(info);
    return;
  }
  if (await playFallback(title, stream, streams)) return;

  const dead = stream.server === "turbovip";
  showWatchMessage([
    h("div", { class: "alert alert-warning d-inline-block text-start mb-0" },
      h("strong", { text: dead ? "Server turbovip tidak tersedia." : "Server ini tidak bisa diputar inline." }),
      h("div", {
        class: "small",
        text: dead
          ? "Domain penyedia (turbonewvid.com) sudah tidak aktif; ini juga memengaruhi pemutar di situs sumber."
          : info && info.error
            ? info.error
            : "Penyedia membatasi pemutaran di luar situsnya (X-Frame-Options).",
      }),
      h("div", { class: "small mt-1", text: "Coba server lain di daftar (biasanya p2p)." }),
    ),
  ]);
  watchNote.textContent = "";
}

document.getElementById("watchModal").addEventListener("hidden.bs.modal", resetWatch);

function streamButtons(streams, defaultUrl, title) {
  const wrap = h("div", { class: "d-flex flex-wrap gap-2" });
  for (const stream of streams) {
    const isDefault = defaultUrl && stream.url === defaultUrl;
    const button = h("button", {
      class: `btn btn-sm ${isDefault ? "btn-primary" : "btn-outline-light"}`,
      type: "button",
      text: `Nonton · ${stream.server}`,
      onclick: () => startWatch(title, stream, streams),
    });
    wrap.append(button);
    void getStreamInfo(stream.url).then((info) => {
      if (!info || info.error) return;
      if (info.hls) {
        button.title = "Dapat diputar langsung (HLS).";
        return;
      }
      if (info.embeddable) {
        button.title = "Dimuat sebagai embed.";
        return;
      }
      button.classList.remove("btn-primary", "btn-outline-light");
      button.classList.add("btn-outline-secondary");
      button.title = "Server ini membatasi embed; klik untuk detail.";
    });
  }
  if (wrap.children.length === 0) {
    wrap.append(h("span", { class: "text-secondary small", text: "Tidak ada sumber streaming." }));
  }
  return wrap;
}

function metaBadges(detail) {
  const chips = h("div", { class: "d-flex flex-wrap gap-1 mb-2" });
  chips.append(badge(detail.type === "series" ? "series" : "movie", detail.type === "series" ? "info" : "warning"));
  if (detail.year) chips.append(badge(detail.year, "secondary"));
  if (detail.rating) chips.append(badge(`★ ${detail.rating}`, "success"));
  if (detail.status) chips.append(badge(detail.status, "secondary"));
  if (detail.duration) chips.append(badge(detail.duration, "secondary"));
  if (detail.quality) chips.append(badge(detail.quality, "secondary"));
  if (detail.resolution) chips.append(badge(detail.resolution, "secondary"));
  if (detail.totalSeasons) chips.append(badge(`${detail.totalSeasons} season`, "secondary"));
  if (detail.totalEpisodes) chips.append(badge(`${detail.totalEpisodes} episode`, "secondary"));
  return chips;
}

function detailHeader(detail) {
  const poster = detail.poster
    ? h("img", { class: "detail-poster", src: detail.poster, alt: detail.title || "" })
    : h("div", { class: "detail-poster poster-empty", text: "no poster" });

  const info = h(
    "div",
    { class: "flex-grow-1" },
    metaBadges(detail),
    detail.genres && detail.genres.length ? h("div", { class: "small text-info mb-1", text: detail.genres.join(" · ") }) : null,
    detail.countries && detail.countries.length ? h("div", { class: "small text-secondary mb-1", text: detail.countries.join(", ") }) : null,
    detail.directors && detail.directors.length ? h("div", { class: "small text-secondary", text: `Sutradara: ${detail.directors.join(", ")}` }) : null,
    detail.casts && detail.casts.length ? h("div", { class: "small text-secondary", text: `Pemain: ${detail.casts.slice(0, 6).join(", ")}` }) : null,
    detail.synopsis ? h("p", { class: "mt-2 mb-0 small", text: detail.synopsis }) : null,
  );

  return h("div", { class: "d-flex gap-3 mb-3" }, poster, info);
}

function renderDetail(detail) {
  detailTitle.textContent = detail.title || "Detail";
  detailBody.replaceChildren(detailHeader(detail));

  if (detail.downloadUrl) {
    detailBody.append(
      h(
        "div",
        { class: "mb-3" },
        h("a", { class: "btn btn-sm btn-outline-secondary", href: detail.downloadUrl, target: "_blank", rel: "noreferrer", text: "Unduh" }),
      ),
    );
  }

  if (detail.type === "series") {
    renderSeriesBody(detail);
  } else {
    detailBody.append(h("h6", { text: "Sumber streaming" }), streamButtons(detail.streams ?? [], null, detail.title));
  }
}

function renderSeriesBody(detail) {
  const seasons = detail.seasons ?? [];
  const streamArea = h("div", { class: "mt-3" });

  const pickEpisode = async (slug, label) => {
    streamArea.replaceChildren(spinner());
    try {
      const episode = await api(`/v1/episode?slug=${encodeURIComponent(slug)}`);
      const title = episode.title || label;
      const blocks = [
        h("h6", { class: "mb-2", text: `Sumber · ${title}` }),
        streamButtons(episode.streams ?? [], episode.defaultStream, title),
      ];
      if (episode.downloadUrl) {
        blocks.push(
          h("a", { class: "btn btn-sm btn-outline-secondary mt-2", href: episode.downloadUrl, target: "_blank", rel: "noreferrer", text: "Unduh episode" }),
        );
      }
      if (episode.next) {
        blocks.push(
          h("div", { class: "mt-2" },
            h("button", {
              class: "btn btn-sm btn-outline-primary",
              type: "button",
              text: `Episode berikutnya · S${episode.next.season}E${episode.next.episode}`,
              onclick: () => pickEpisode(episode.next.slug, episode.next.title),
            }),
          ),
        );
      }
      streamArea.replaceChildren(...blocks.filter(Boolean));
    } catch (error) {
      streamArea.replaceChildren(h("div", { class: "alert alert-danger mb-0", text: error.message }));
    }
  };

  if (seasons.length === 0) {
    detailBody.append(h("p", { class: "text-secondary", text: "Daftar episode tidak tersedia." }));
    return;
  }

  const epGrid = h("div", { class: "episode-grid" });
  const renderSeason = (season) => {
    epGrid.replaceChildren();
    for (const episode of season.episodes) {
      epGrid.append(
        h("button", {
          class: "btn btn-sm btn-outline-light",
          type: "button",
          text: `E${episode.episode}`,
          title: episode.title,
          onclick: () => pickEpisode(episode.slug, episode.title),
        }),
      );
    }
  };

  const seasonBar = h("div", { class: "btn-group btn-group-sm mb-2 flex-wrap" });
  seasons.forEach((season, index) => {
    seasonBar.append(
      h("button", {
        class: `btn btn-outline-secondary${index === 0 ? " active" : ""}`,
        type: "button",
        text: `Season ${season.season}`,
        onclick: (event) => {
          seasonBar.querySelectorAll(".btn").forEach((btn) => btn.classList.remove("active"));
          event.currentTarget.classList.add("active");
          renderSeason(season);
        },
      }),
    );
  });

  renderSeason(seasons[0]);
  detailBody.append(h("h6", { text: "Episode" }));
  if (seasons.length > 1) detailBody.append(seasonBar);
  detailBody.append(epGrid, h("hr"), streamArea);

  const first = seasons[0].episodes[0];
  if (first) void pickEpisode(first.slug, first.title);
}

async function openDetail(slug, title) {
  detailTitle.textContent = title || "Detail";
  detailBody.replaceChildren(spinner());
  detailModal.show();
  try {
    const detail = await api(`/v1/movie?slug=${encodeURIComponent(slug)}`);
    renderDetail(detail);
  } catch (error) {
    detailBody.replaceChildren(h("div", { class: "alert alert-danger mb-0", text: error.message }));
  }
}

// ---------------------------------------------------------------------------
// API explorer
// ---------------------------------------------------------------------------
const ENDPOINTS = [
  { id: "health", label: "GET /v1/health", arg: null },
  { id: "home", label: "GET /v1/home", arg: null },
  { id: "latest", label: "GET /v1/latest", arg: null },
  { id: "popular", label: "GET /v1/popular", arg: null },
  { id: "rating", label: "GET /v1/rating", arg: null },
  { id: "release", label: "GET /v1/release", arg: null },
  { id: "series", label: "GET /v1/series", arg: null },
  { id: "search", label: "GET /v1/search", arg: "kata kunci" },
  { id: "genre", label: "GET /v1/genre/:slug", arg: "action" },
  { id: "country", label: "GET /v1/country/:slug", arg: "south-korea" },
  { id: "year", label: "GET /v1/year/:year", arg: "2026" },
  { id: "movie", label: "GET /v1/movie", arg: "slug atau url" },
  { id: "episode", label: "GET /v1/episode", arg: "slug atau url" },
  { id: "stream", label: "GET /v1/stream", arg: "url player" },
  { id: "genres", label: "GET /v1/genres", arg: null },
  { id: "countries", label: "GET /v1/countries", arg: null },
];

const endpointSelect = document.getElementById("endpoint");
const argInput = document.getElementById("arg");
const pageInput = document.getElementById("page");
const pagesInput = document.getElementById("pages");
const limitInput = document.getElementById("limit");
const requestForm = document.getElementById("request-form");
const requestUrl = document.getElementById("request-url");
const jsonOut = document.getElementById("result-json");
const endpointHint = document.getElementById("endpoint-hint");

for (const endpoint of ENDPOINTS) {
  endpointSelect.append(h("option", { value: endpoint.id, text: endpoint.label }));
}

function currentEndpoint() {
  return ENDPOINTS.find((entry) => entry.id === endpointSelect.value) ?? ENDPOINTS[0];
}

function syncArgField() {
  const endpoint = currentEndpoint();
  if (!endpoint.arg) {
    argInput.value = "";
    argInput.disabled = true;
    argInput.placeholder = "tidak diperlukan";
    endpointHint.textContent = "Endpoint ini tidak memerlukan argumen.";
  } else {
    argInput.disabled = false;
    argInput.placeholder = endpoint.arg;
    endpointHint.textContent =
      endpoint.id === "movie" || endpoint.id === "episode"
        ? "Masukkan slug (mis. kate-2026) atau URL lengkap."
        : "Masukkan argumen lalu kirim.";
  }
}

function buildUrl() {
  const endpoint = currentEndpoint();
  const arg = argInput.value.trim();
  const page = pageInput.value.trim();
  const pages = pagesInput.value.trim();
  const limit = limitInput.value.trim();

  const listParams = new URLSearchParams();
  if (page) listParams.set("page", page);
  if (pages) listParams.set("pages", pages);
  if (limit) listParams.set("limit", limit);
  const listQs = listParams.toString();

  switch (endpoint.id) {
    case "health":
    case "genres":
    case "countries":
      return `/v1/${endpoint.id}`;
    case "home":
    case "latest":
    case "popular":
    case "rating":
    case "release":
    case "series":
      return `/v1/${endpoint.id}${listQs ? `?${listQs}` : ""}`;
    case "search": {
      const params = new URLSearchParams({ q: arg });
      if (page) params.set("page", page);
      if (limit) params.set("limit", limit);
      return `/v1/search?${params.toString()}`;
    }
    case "genre":
      return `/v1/genre/${encodeURIComponent(arg)}${listQs ? `?${listQs}` : ""}`;
    case "country":
      return `/v1/country/${encodeURIComponent(arg)}${listQs ? `?${listQs}` : ""}`;
    case "year":
      return `/v1/year/${encodeURIComponent(arg)}${listQs ? `?${listQs}` : ""}`;
    case "movie":
    case "episode": {
      const target = /^https?:\/\//i.test(arg) ? "url" : "slug";
      return `/v1/${endpoint.id}?${new URLSearchParams({ [target]: arg }).toString()}`;
    }
    case "stream":
      return `/v1/stream?${new URLSearchParams({ url: arg }).toString()}`;
    default:
      return "/v1/health";
  }
}

async function sendExplorer() {
  const url = buildUrl();
  requestUrl.textContent = url;
  jsonOut.textContent = "memuat…";
  try {
    const response = await fetch(url);
    const body = await response.json();
    jsonOut.textContent = JSON.stringify({ status: response.status, ...body }, null, 2);
  } catch (error) {
    jsonOut.textContent = JSON.stringify({ error: "network_error", message: String(error) }, null, 2);
  }
}

endpointSelect.addEventListener("change", syncArgField);
requestForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendExplorer();
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
const healthDot = document.getElementById("health-dot");
const healthText = document.getElementById("health-text");

async function checkHealth() {
  try {
    const body = await api("/v1/health");
    const ok = body.redis === "ok";
    healthDot.className = `dot ${ok ? "ok" : "bad"}`;
    healthText.textContent = `redis: ${body.redis} · cloudscraper: ${body.cloudscraper}`;
  } catch {
    healthDot.className = "dot bad";
    healthText.textContent = "tidak dapat menghubungi API";
  }
}

syncArgField();
void checkHealth();
selectBrowse("home");
