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

```bash
cp .env.example .env
npm install

# Redis
npm run redis:start            # atau: redis-server

# Sidecar (opsional; hanya dipakai saat kena challenge)
npm run py:install
npm run py:start

# API
npm run dev:api                # tsx watch
# atau produksi
npm run build && npm run start:api
```

Buka <http://localhost:3000> untuk UI penguji. Cek `GET /v1/health`.

### Cepat (satu perintah)

```bash
./run-web.sh                 # siapkan .env, jalankan Redis + API dev
./run-web.sh --prod          # build lalu jalankan hasil build
./run-web.sh --cloudscraper  # sekalian jalankan sidecar Python
```

Script akan membuat `.env` bila belum ada, menyalakan Redis (bila belum jalan),
lalu mencetak URL UI. Tekan Ctrl+C untuk berhenti.

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
| `LK21_URL` | `https://www.lk21.de` | Base URL situs **film** (domain sering berganti) |
| `LK21_SERIES_URL` | `https://dramamu.lk21.de` | Base URL situs **series** (Nontondrama) |
| `LK21_SEARCH_URL` | `https://gudangvape.com/` | Base URL endpoint JSON pencarian |
| `LK21_POSTER_URL` | `https://poster.assetsy.de/wp-content/uploads/` | Prefix poster relatif hasil pencarian |
| `ALLOWED_HOSTS` | _(kosong)_ | Allowlist host; kosong = otomatis dari host LK21 |
| `ALLOW_PRIVATE_HOSTS` | `false` | Izinkan host privat (hanya untuk tes lokal) |
| `CLOUDSCRAPER_ENABLED` | `true` | Pakai sidecar saat kena challenge |
| `CLOUDSCRAPER_URL` | `http://127.0.0.1:8000` | Alamat sidecar |
| `CACHE_TTL_SECONDS` | `1800` | TTL cache |
| `MAX_PAGES_PER_REQUEST` | `20` | Batas `pages` per request |
| `DEFAULT_LIST_LIMIT` | `24` | `limit` default |

> **Film dan series dipisah oleh LK21.** `www.lk21.de` (film) otomatis redirect
> ke mirror resmi yang aktif (mis. `tv12.lk21official.cc`) dan hanya menyajikan
> film; series ada di `dramamu.lk21.de` (alias `tv9.nontondrama.my`). Karena itu
> ada dua base: `LK21_URL` untuk film dan `LK21_SERIES_URL` untuk series.
> `/v1/latest` membaca sisi film sedangkan `/v1/series` membaca sisi series,
> jadi keduanya tidak lagi menampilkan data yang sama.
>
> **Domain promo / landing page.** Beberapa domain yang beredar (mis.
> `d21.team`) hanya menyajikan halaman promosi yang mengarahkan ke situs asli.
> Saat `LK21_URL` menunjuk domain seperti itu, API mendeteksi landing page,
> mengikuti tautan "ke halaman LK21", dan memakai origin asli (mis.
> `https://www.lk21.de`) untuk semua endpoint — termasuk saat `?url=` berisi
> tautan landing.

---

## Endpoint

Base path: `/v1`. Detail lengkap ada di [`docs/API.md`](docs/API.md).

| Endpoint | Keterangan |
| --- | --- |
| `GET /v1/health` | Status Redis + sidecar |
| `GET /v1/home` | Bagian-bagian beranda |
| `GET /v1/latest` | Film terbaru |
| `GET /v1/popular` | Film populer |
| `GET /v1/rating` | Rating tertinggi |
| `GET /v1/release` | Rilis terbaru |
| `GET /v1/series` | Series terbaru |
| `GET /v1/search?q=` | Pencarian |
| `GET /v1/genre/:slug` | Film/series per genre (`?type=series` untuk situs series) |
| `GET /v1/country/:slug` | Film/series per negara (`?type=series`) |
| `GET /v1/year/:year` | Film/series per tahun (`?type=series`) |
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
