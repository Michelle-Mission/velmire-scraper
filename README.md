# velmire-scraper

REST API untuk mengambil data dari **LK21 (LayarKaca21)** — daftar film/series,
pencarian, detail, dan link streaming/episode. Dibangun dengan TypeScript
(Fastify + Cheerio + Axios), Redis sebagai cache, dan sidecar Python berbasis
`cloudscraper` untuk menangani challenge Cloudflare bila perlu.

> Catatan: tool ini **tidak menjamin** Cloudflare bisa dilewati. Bila challenge
> masih ada setelah percobaan, request akan gagal dengan pesan error yang jelas.
> Gunakan hanya pada sumber yang kamu punya izin mengaksesnya.

---

## Arsitektur

```
   Browser --> Web UI (static, /)
                     |
                     v
        +--------------------------+       +------------------+
        |  API TypeScript (Fastify) | <---> | Redis (cache)    |
        |  REST /v1 + rate limit    |       +------------------+
        +------------+-------------+
                     |  HTTP (axios)
                     v
        target LK21 site  <--- challenge --->  CloudScraper sidecar (Python)
```

- **Frontend** (`web/`) — UI Bootstrap 5 (aset lokal, tanpa CDN) + JS tanpa build
  step, disajikan oleh API. Klik judul membuka detail in-app (`/v1/movie`) lalu
  tombol **Nonton** memakai `/v1/stream`: bila provider punya HLS langsung
  (server `p2p`) diputar via `<video>` + hls.js, dengan playlist & segmen
  di-proxy melalui **satu** endpoint `/v1/stream` (mode `proxy=1`, same-origin,
  auto-deteksi playlist vs segmen); jika tidak, dicoba embed. Genre/negara
  dirender sebagai chip filter (bukan kartu), dengan toggle situs Film/Series.
  Tab **API** menyediakan eksplorer endpoint.
- **API** (`src/api/`) — Fastify, semua endpoint di bawah `/v1`.
- **Scraper** (`src/lk21/`) — HTTP client + parser Cheerio + service layer yang
  meng-cache hasil ke Redis.
- **Shared** (`src/shared/`) — konfigurasi, cache, tipe, URL guard, koneksi Redis.
- **Sidecar** (`services/cloudscraper/`) — layanan Python `cloudscraper` (`POST /fetch`).

Fitur utama:

- Satu endpoint per kategori: home, latest, popular, rating, release, series.
- Scrape seluruh filter navbar tv9 (Genre, Series, Negara, Tahun) lewat
  `/v1/filters` + `/v1/filter`, plus daftar film dari portal Lk21 (`/v1/movies/*`).
- Pencarian lewat endpoint JSON milik sumber. Endpoint ini memverifikasi
  `Referer`, jadi header itu dikirim memakai origin mirror aktif (di-resolve
  dulu dari `LK21_URL`), bukan domain promo/landing.
- Filter genre, country, dan tahun dengan agregasi pagination.
- Detail film/series dan detail episode (termasuk daftar server streaming).
- Cache Redis dengan TTL (default 30 menit).
- Rate limiting, CORS, allowlist host (SSRF guard).

---

## Menjalankan

Butuh Node.js >= 20, Redis, dan Python 3 (untuk sidecar).

Cukup satu perintah; semua service dinyalakan otomatis:

```bash
./run-web.sh          # dev: Redis + cloudscraper + API
./run-web.sh --prod   # build lalu jalankan semuanya
# atau lewat npm
npm run dev
npm start
```

Script akan membuat `.env` bila belum ada, menyalakan Redis, memasang/menjalankan
sidecar cloudscraper, lalu API. Tekan Ctrl+C untuk mematikan API dan sidecar.
Buka <http://localhost:3000> untuk UI penguji, cek `GET /v1/health`.

### Docker

```bash
docker compose up --build
```

Menjalankan Redis, sidecar cloudscraper, dan API.

---

## Konfigurasi

Semua lewat environment (lihat `.env.example`):

| Variable | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port API |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis untuk cache |
| `LK21_URL` | `https://tv9.nontondrama.my` | Base sumber utama (tv9) untuk semua endpoint |
| `LK21_MOVIES_URL` | `https://d21.team` | Portal film dari navbar Lk21 (landing → situs film live) |
| `LK21_SEARCH_URL` | `https://gudangvape.com/` | Base URL endpoint JSON pencarian |
| `LK21_POSTER_URL` | `https://poster.assetsy.de/wp-content/uploads/` | Prefix poster relatif hasil pencarian |
| `ALLOWED_HOSTS` | _(kosong)_ | Allowlist host; kosong = otomatis dari host LK21 |
| `ALLOW_PRIVATE_HOSTS` | `false` | Izinkan host privat (hanya untuk tes lokal) |
| `CLOUDSCRAPER_ENABLED` | `true` | Pakai sidecar saat kena challenge |
| `CLOUDSCRAPER_URL` | `http://127.0.0.1:8000` | Alamat sidecar |
| `CLOUDSCRAPER_ALLOWED_HOSTS` | _tv9/lk21/gudangvape/player_ | Host yang boleh di-fetch sidecar (`*.domain` didukung) |
| `CLOUDSCRAPER_MAX_BYTES` | `2000000` | Batas ukuran respons sidecar |
| `CLOUDSCRAPER_BROWSER` | `chrome` | Profil browser: `chrome`, `firefox`, `native` |
| `CLOUDSCRAPER_DELAY` | `0` | Jeda (detik) saat menyelesaikan challenge |
| `CLOUDSCRAPER_TOKEN` | _(kosong)_ | Token `X-Auth-Token` antara API dan sidecar |
| `CACHE_TTL_SECONDS` | `1800` | TTL cache |
| `MAX_PAGES_PER_REQUEST` | `20` | Batas `pages` per request |
| `DEFAULT_LIST_LIMIT` | `24` | `limit` default |

> **Satu base untuk konten tv9.** `LK21_URL` menunjuk
> `https://tv9.nontondrama.my`; tidak ada base series terpisah. Semua URL yang
> dipancarkan endpoint tv9 (list, detail, episode, pencarian) memakai host ini.
> Hanya daftar film navbar yang membaca portal `LK21_MOVIES_URL` (`d21.team`),
> dan item-nya tetap dipancarkan sebagai URL tv9.
>
> **Detail film lewat tv9.** Slug film di tv9 dialihkan ke halaman promo
> (`d21.team`) yang menautkan ke situs film asli. API mengikuti tautan itu
> sekali untuk mengambil data, lalu tetap memancarkan URL `tv9` agar klien hanya
> melihat satu domain.
>
> **Cloudscraper.** Sidecar hanya dipanggil saat request langsung mendeteksi
> challenge Cloudflare. Konfigurasi di atas memperbaiki profil browser, referer,
> dan cookie session. cloudscraper mampu melewati challenge JS/IUAM lama, tetapi
> **bukan** Turnstile/CAPTCHA interaktif; jika challenge tetap muncul, API
> mengembalikan `challenge_not_solved`.

---

## Endpoint

Base path: `/v1`. Detail lengkap ada di [`docs/API.md`](docs/API.md).

| Endpoint | Keterangan |
| --- | --- |
| `GET /v1/health` | Status Redis + sidecar |
| `GET /v1/home` | Bagian-bagian beranda |
| `GET /v1/latest` | Konten terbaru (tv9) |
| `GET /v1/popular` | Konten populer (tv9) |
| `GET /v1/rating` | Rating tertinggi (tv9) |
| `GET /v1/release` | Rilis terbaru (tv9) |
| `GET /v1/series` | Series terbaru |
| `GET /v1/series/:filter` | Series `ongoing` / `complete` / `west` / `asian` |
| `GET /v1/filters` | Struktur filter navbar tv9 |
| `GET /v1/filter?path=` | Scrape path filter tv9 (`genre/…`, `country/…`, `year/…`, `series/…`, `latest`, `populer`, `rating`, `release`) |
| `GET /v1/movies/:kind` | Daftar film portal Lk21: `home` / `latest` / `popular` / `top` |
| `GET /v1/search?q=` | Pencarian |
| `GET /v1/genre/:slug` | Konten tv9 per genre |
| `GET /v1/country/:slug` | Konten tv9 per negara |
| `GET /v1/year/:year` | Konten tv9 per tahun |
| `GET /v1/movie?url=\|?slug=` | Detail film/series |
| `GET /v1/episode?url=\|?slug=` | Detail episode |
| `GET /v1/stream?url=` | Resolve player (`iframe3`) → info + `hls`; atau proxy media (`proxy=1`): rewrite playlist / byte segmen (dukung Range) |
| `GET /v1/genres` | Daftar genre |
| `GET /v1/countries` | Daftar negara |

Daftar mendukung query `page`, `pages` (jumlah halaman yang digabung), dan
`limit`.

Contoh:

```bash
curl 'http://localhost:3000/v1/latest?page=1&limit=12'
curl 'http://localhost:3000/v1/search?q=doctor+x'
curl 'http://localhost:3000/v1/movie?slug=kate-2026'
```

---

## Pengujian

```bash
npm run typecheck
npm test
```

- `tests/parsers.test.ts` — parser HTML (fixture).
- `tests/url-guard.test.ts` — allowlist/SSRF guard.
- `tests/integration.test.ts` — API `/v1` end-to-end dengan server mock + Redis
  (otomatis di-skip bila `redis-server` tidak tersedia).

---

## Legal

Scraper ini hanya untuk keperluan pribadi/edukasi. Hargai hak cipta dan
ketentuan layanan sumber. Penulis tidak bertanggung jawab atas penyalahgunaan.
