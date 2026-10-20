# API Reference

Base URL: `http://localhost:3000` (atau host/port sesuai konfigurasi).
Semua endpoint berada di bawah prefix `/v1`.

- Konten `application/json` untuk seluruh response.
- Rate limit default: 60 request / 60 detik per IP.
- Error dikembalikan dengan bentuk:

```json
{ "error": "kode_error", "message": "penjelasan" }
```

## Daftar isi

- [Umum](#umum)
- [Pagination](#pagination)
- [Health](#health)
- [Beranda](#beranda)
- [Daftar (listing)](#daftar-listing)
- [Filter navbar](#filter-navbar)
- [Daftar film (portal)](#daftar-film-portal)
- [Pencarian](#pencarian)
- [Genre / Country / Year](#genre--country--year)
- [Detail film & series](#detail-film--series)
- [Detail episode](#detail-episode)
- [Resolver & proxy stream](#resolver--proxy-stream)
- [Taxonomy](#taxonomy)
- [Tipe data](#tipe-data)
- [Kode error](#kode-error)

---

## Umum

### Query pagination

Endpoint listing menerima query berikut:

| Param | Tipe | Default | Keterangan |
| --- | --- | --- | --- |
| `page` | integer >= 1 | `1` | Halaman sumber pertama yang diambil |
| `pages` | integer >= 1 | `1` | Jumlah halaman sumber yang digabung (maks `MAX_PAGES_PER_REQUEST`, default 20) |
| `limit` | integer >= 1 | `DEFAULT_LIST_LIMIT` (24) | Jumlah item maksimum yang dikembalikan |

`pages` > 1 akan mengambil halaman `page`, `page+1`, ... lalu digabung dan
dipotong sesuai `limit`. Semua hasil di-cache di Redis selama
`CACHE_TTL_SECONDS`.

---

## Health

### `GET /v1/health`

```json
{
  "status": "ok",
  "redis": "ok",
  "cloudscraper": "ok",
  "source": "https://www.lk21.de",
  "uptime": 12.34,
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

- `status`: `ok` | `degraded`
- `redis`: `ok` | `down`
- `cloudscraper`: `ok` | `unreachable` | `disabled`

---

## Beranda

### `GET /v1/home`

Mengembalikan setiap widget beranda sebagai satu section.

Query: `limit` (opsional, membatasi jumlah item per section),
`type` (opsional, `movie` default | `series`).

> Semua endpoint memakai satu base: `LK21_URL` (`https://tv9.nontondrama.my`).
> Parameter `type` tetap diterima demi kompatibilitas, tetapi beranda yang
> tersedia adalah beranda tv9.
>
> Jika slug film dialihkan ke halaman promo/landing (mis. `d21.team`), API
> mengikuti tautan ke situs asli sekali untuk mengambil data, lalu tetap
> memancarkan URL `tv9`. Hal yang sama berlaku untuk
> `?url=` yang berisi tautan landing.

```json
{
  "sections": [
    {
      "title": "Series Terbaru",
      "seeAll": "https://www.lk21.de/latest-series",
      "type": "latest-series",
      "count": 12,
      "items": [ /* ListItem[] */ ]
    }
  ]
}
```

---

## Daftar (listing)

Semua endpoint di bawah ini mengembalikan `ListResult` dan menerima query
pagination (`page`, `pages`, `limit`).

| Endpoint | Path sumber | Keterangan |
| --- | --- | --- |
| `GET /v1/latest` | `/latest` | Konten terbaru tv9 |
| `GET /v1/popular` | `/populer` | Terpopuler tv9 |
| `GET /v1/rating` | `/rating` | Rating tertinggi tv9 |
| `GET /v1/release` | `/release` | Rilis terbaru tv9 |
| `GET /v1/series` | `/latest-series` | Series terbaru tv9 |
| `GET /v1/series/:filter` | `/series/:filter` | `ongoing` / `complete` / `west` / `asian` |

Filter lain dari navbar bisa diambil lewat `GET /v1/filter?path=...`
(lihat [Filter navbar](#filter-navbar)).

```json
{
  "page": 1,
  "pages": 2,
  "totalPages": 42,
  "count": 24,
  "items": [ /* ListItem[] */ ]
}
```

- `pages`: jumlah halaman sumber yang benar-benar diambil.
- `totalPages`: total halaman sumber (bila terdeteksi), bisa `null`.

---

## Filter navbar

Semua filter yang tampil di navbar tv9 bisa di-scrape. `GET /v1/filters`
mengembalikan struktur menu (Genre, Lk21, Series, Negara, Tahun, + More) beserta
`label`, `url`, `path`, `slug`, dan `kind`
(`genre` | `country` | `year` | `series` | `movie` | `page` | `external`).

### `GET /v1/filters`

```json
{
  "groups": [
    {
      "label": "Genre",
      "items": [
        { "label": "Action", "url": "https://tv9.nontondrama.my/genre/action", "path": "genre/action", "slug": "action", "kind": "genre" }
      ]
    },
    {
      "label": "Lk21",
      "items": [
        { "label": "Film Terbaru", "url": "https://d21.team/latest", "path": "latest", "slug": "latest", "kind": "movie" }
      ]
    }
  ]
}
```

### `GET /v1/filter`

Scrape path filter internal tv9 secara generik. Path yang didukung:
`genre/…`, `country/…`, `year/…`, `series/…`, serta daftar
`latest`, `populer`, `rating`, `release`, `latest-series`.

| Param | Wajib | Keterangan |
| --- | --- | --- |
| `path` | ya | Mis. `series/ongoing`, `genre/action`, `country/japan`, `year/2026` |
| `page`, `pages`, `limit` | tidak | Query pagination |

```bash
curl 'http://localhost:3000/v1/filter?path=series/ongoing'
curl 'http://localhost:3000/v1/filter?path=country/japan&limit=12'
```

Response: `ListResult`. Path di luar daftar (termasuk percobaan path traversal)
ditolak dengan `400 invalid_filter`.

---

## Daftar film (portal)

Navbar **Lk21** mengarah ke portal film `d21.team` (halaman landing yang
meneruskan ke situs film live). API mengikuti landing tersebut otomatis dan
mengembalikan item dengan URL tv9 agar detail tetap bisa diambil lewat
`/v1/movie?slug=...`.

| Endpoint | Keterangan |
| --- | --- |
| `GET /v1/movies/home` | Beranda portal film |
| `GET /v1/movies/latest` | Film terbaru |
| `GET /v1/movies/popular` | Film terpopuler |
| `GET /v1/movies/top` | Film unggulan hari ini |

Semua menerima query pagination dan mengembalikan `ListResult`.
`kind` yang tidak dikenal → `400 invalid_kind`.

---

## Pencarian

### `GET /v1/search`

| Param | Wajib | Keterangan |
| --- | --- | --- |
| `q` | ya | Kata kunci |
| `page` | tidak | Halaman hasil |
| `limit` | tidak | Batas jumlah item |

```bash
curl 'http://localhost:3000/v1/search?q=doctor+x&page=1'
```

Response: `ListResult`.

---

## Genre / Country / Year

| Endpoint | Keterangan |
| --- | --- |
| `GET /v1/genre/:slug` | Mis. `/v1/genre/action` |
| `GET /v1/country/:slug` | Mis. `/v1/country/south-korea` |
| `GET /v1/year/:year` | `:year` harus 4 digit, mis. `/v1/year/2026` |

Semua menerima query pagination dan `type` (`movie` default | `series`) untuk
memilih situs film atau series, lalu mengembalikan `ListResult`.

`/v1/year/:year` akan mengembalikan `400 invalid_year` bila format tidak sesuai.

---

## Detail film & series

### `GET /v1/movie`

Ambil detail berdasarkan `slug` **atau** `url` (salah satu wajib).

| Param | Keterangan |
| --- | --- |
| `slug` | Slug konten, mis. `kate-2026` |
| `url` | URL lengkap; divalidasi terhadap allowlist |

```bash
curl 'http://localhost:3000/v1/movie?slug=kate-2026'
curl --get --data-urlencode 'url=https://www.lk21.de/kate-2026' \
  'http://localhost:3000/v1/movie'
```

Response: `DetailResult`. `type` bernilai `"movie"` atau `"series"`.
Untuk series, `seasons` berisi daftar episode per season.

Slug series dilayani langsung oleh tv9. Slug film yang dialihkan ke halaman
promo tetap diikuti otomatis agar detailnya bisa diambil.

---

## Detail episode

### `GET /v1/episode`

| Param | Keterangan |
| --- | --- |
| `slug` | Slug episode, mis. `doctor-x-age-white-mafia-season-1-episode-1-2026` |
| `url` | URL lengkap episode; divalidasi terhadap allowlist |

Response: `EpisodeResult`. Episode diambil dari base `LK21_URL` (tv9).
Jika `slug` adalah halaman series (bukan episode), API membalas `400 not_an_episode`;
gunakan `/v1/movie?slug=...` untuk detail series.

---

## Resolver & proxy stream

### `GET /v1/stream`

Satu endpoint dengan dua peran, dipilih otomatis:

1. **Resolver** — bila `url` adalah halaman player LK21
   (`videonode.de/iframe3/<server>/<id>`): resolve player asli di balik
   `POST /api.php` dan kembalikan JSON informasi.
2. **Proxy media** — bila `proxy=1` diberikan **atau** `url` bukan URL player:
   ambil URL tersebut dan kirim ulang lewat origin ini. Playlist `.m3u8`
   (berawalan `#EXTM3U`) di-rewrite sedemikian sehingga seluruh URI anak
   (variant, segmen, key) kembali menunjuk ke `/v1/stream?proxy=1&url=...`;
   selain itu byte dikirim apa adanya (mendukung `Range`/`206`). Ini menghindari
   CORS karena UI satu origin dengan API.

| Param | Keterangan |
| --- | --- |
| `url` | URL player (mode resolver) atau URL media (mode proxy) |
| `proxy` | `1` untuk memaksa mode proxy |
| `Range` (header) | Diteruskan ke sumber saat mem-proxy segmen |

Resolver:

```bash
curl --get --data-urlencode \
  'url=https://videonode.de/iframe3/p2p/<id>' \
  'http://localhost:3000/v1/stream'
```

```json
{
  "server": "p2p",
  "player": "https://videonode.de/iframe3/p2p/<id>",
  "embed": "https://playcdn.de/<slug>?cb=3",
  "embeddable": false,
  "hls": "https://stream.playcdn.de/playlist/<hash>/1/0.m3u8?x=1"
}
```

- `embed`: URL player asli (untuk di-embed / dimuat).
- `embeddable`: `false` bila player mengirim CSP `frame-ancestors` /
  `X-Frame-Options` yang melarang embed.
- `hls`: URL `.m3u8` langsung bila provider mengeksposnya (mis. server `p2p`).
  Bila ada, UI memutar via `<video>` + hls.js memakai mode proxy endpoint ini.

Proxy:

```bash
curl --get --data-urlencode 'proxy=1' --data-urlencode 'url=<m3u8 atau segmen>' \
  'http://localhost:3000/v1/stream'
```

---

## Taxonomy

| Endpoint | Response |
| --- | --- |
| `GET /v1/genres` | `TaxonomyItem[]` |
| `GET /v1/countries` | `TaxonomyItem[]` |

```json
[
  { "name": "Action", "slug": "action", "url": "https://www.lk21.de/genre/action" }
]
```

---

## Tipe data

### `ListItem`

```ts
{
  title: string;
  slug: string;
  url: string;
  type: "movie" | "series";
  poster: string | null;
  rating: number | null;
  year: number | null;
  episode: number | null;   // jumlah episode (series)
  season: number | null;    // season saat ini (series)
  duration: string | null;  // runtime "HH:MM" (movie)
  quality: string | null;
  genres: string[];
  complete: boolean;
}
```

### `ListResult`

```ts
{
  page: number;
  pages: number;
  totalPages: number | null;
  count: number;
  items: ListItem[];
}
```

### `NavFilterItem` / `NavGroup` / `FiltersResult`

```ts
type NavItemKind =
  | "genre" | "country" | "year" | "series" | "movie" | "page" | "external";

interface NavFilterItem {
  label: string;
  url: string;
  path: string;   // tanpa leading slash; kosong untuk link eksternal
  slug: string;
  kind: NavItemKind;
}

interface NavGroup { label: string; items: NavFilterItem[] }
interface FiltersResult { groups: NavGroup[] }
```

### `DetailResult`

> `streams` digabung dari `#player-list` dan `#player-select`, jadi server yang
> hanya muncul di dropdown (mis. `turbovip`) tetap ikut terdaftar.

```ts
{
  title: string;
  slug: string;
  url: string;
  type: "movie" | "series";
  poster: string | null;
  rating: number | null;
  year: number | null;
  duration: string | null;
  quality: string | null;
  resolution: string | null;
  status: string | null;          // "Ongoing" | "Complete" | ...
  synopsis: string | null;
  trailer: string | null;
  genres: string[];
  countries: string[];
  directors: string[];
  casts: string[];
  downloadUrl: string | null;
  streams: { server: string; url: string }[];
  playFirst: string | null;
  playLatest: string | null;
  totalSeasons: number | null;
  totalEpisodes: number | null;
  seasons: { season: number; episodes: EpisodeLink[] }[];
}
```

### `EpisodeLink`

```ts
{ season: number; episode: number; title: string; slug: string; url: string }
```

### `EpisodeResult`

> `streams` digabung dari `#player-list` dan `#player-select`, jadi server yang
> hanya muncul di dropdown (mis. `turbovip`) tetap ikut terdaftar.

```ts
{
  title: string;
  slug: string;
  url: string;
  poster: string | null;
  year: number | null;
  series: { title: string; slug: string } | null;
  season: number | null;
  episode: number | null;
  streams: { server: string; url: string }[];
  defaultStream: string | null;
  downloadUrl: string | null;
  prev: EpisodeLink | null;
  next: EpisodeLink | null;
  episodes: EpisodeLink[];
}
```

---

## Kode error

| HTTP | `error` | Keterangan |
| --- | --- | --- |
| 400 | `missing_query` | Parameter `q` pencarian tidak ada |
| 400 | `missing_reference` | `url`/`slug` tidak ada |
| 400 | `missing_url` | Parameter `url` untuk `/v1/stream` tidak ada |
| 400 | `missing_path` | Parameter `path` untuk `/v1/filter` tidak ada |
| 400 | `invalid_filter` | Path/`filter` tidak didukung (atau percobaan path traversal) |
| 400 | `invalid_kind` | `kind` daftar film tidak dikenal |
| 400 | `invalid_player_url` | URL player tidak dikenali (`/iframe3/<server>/<id>`) |
| 400 | `invalid_year` | Format tahun bukan 4 digit |
| 400 | `host_not_allowed` | Host tidak ada di allowlist |
| 400 | `port_not_allowed` | Port tidak diizinkan |
| 400 | `private_address_blocked` | Host menuju alamat privat |
| 400 | `redirect_blocked` | Redirect ke target yang tidak diizinkan |
| 400 | `not_an_episode` | Slug yang diberikan adalah halaman series, bukan episode |
| 404 | `not_found` | Endpoint atau konten (slug) tidak ditemukan |
| 502 | `challenge_not_solved` | Challenge Cloudflare tidak terpecahkan |
| 502 | `cloudscraper_unreachable` | Sidecar tidak berjalan / tidak dapat dihubungi. Jalankan `./run-web.sh` (sidecar ikut otomatis) |
| 502 | `cloudscraper_error` | Sidecar mengembalikan error lain |
| 502 | `stream_resolve_failed` | Gagal resolve player asli dari `/api.php` |
| 502 | `media_fetch_failed` | Gagal memuat playlist/segmen dari sumber (mode proxy) |
| 502 | `invalid_json` | Sumber tidak mengembalikan JSON valid |
| 500 | `internal_error` | Kesalahan tak terduga |
