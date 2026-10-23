# velmire-scraper

REST API untuk mengambil data dari tv9.nontondrama.my: daftar film dan series,
pencarian, detail, serta link streaming. Stack: TypeScript, Fastify, Cheerio,
Axios, Redis, dan sidecar Python `cloudscraper` untuk challenge Cloudflare.

Tool ini tidak menjamin Cloudflare bisa dilewati. Jika challenge tetap muncul,
request akan gagal dengan error yang jelas. Gunakan hanya pada sumber yang kamu
punya izin untuk mengaksesnya.

## Arsitektur

```
Browser
  |
  v
Web UI statis (/)  +  API Fastify (/v1, /stream)
                         |
                         +--> Redis (cache)
                         |
                         +--> Situs sumber (HTTP)
                         |
                         +--> CloudScraper sidecar (Python)
```

- `web/`: UI Bootstrap 5 dengan aset lokal. Detail film dibuka in-app, lalu
  tombol Nonton memanggil `/v1/stream`.
- `src/api/`: route Fastify untuk `/v1/*` dan proxy `/stream/:token`.
- `src/scraper/lk21/`: parser Cheerio dan service yang menyimpan hasil ke Redis.
- `src/player/`: resolver player `p2p` dan `cast`, PoW cast, serta HLS bertanda tangan.
- `src/http/` dan `src/shared/`: HTTP client, konfigurasi, cache, tipe, dan URL guard.
- `services/cloudscraper/`: sidecar Python dengan endpoint `POST /fetch`.

## Fitur

- Home, latest, popular, rating, release, dan series.
- Filter navbar tv9: genre, negara, tahun, dan series.
- Pencarian lewat JSON `search.php`, dengan fallback sitemap tv9.
- Detail film, series, dan episode beserta daftar server.
- Resolve HLS `p2p`/`cast`, fallback iframe Hydrax, dan proxy media same-origin.
- Cache Redis, rate limit, CORS, dan allowlist host untuk mencegah SSRF.

## Menjalankan

Kebutuhan: Node.js 20 atau lebih baru, Redis, dan Python 3 untuk sidecar.
Di Ubuntu/Debian, pasang juga `python3-venv`; script memakai `.venv` bila
`cloudscraper` tidak tersedia di Python sistem.

Cara termudah, semua service dinyalakan otomatis:

```bash
./run-web.sh          # mode dev: Redis + cloudscraper + API
./run-web.sh --prod   # build lalu jalankan semuanya
```

Atau lewat npm:

```bash
npm run dev
npm start
```

Script akan membuat `.env` jika belum ada, menyalakan Redis, menyiapkan sidecar,
lalu menjalankan API. Tekan Ctrl+C untuk menghentikan API dan sidecar.

UI tersedia di <http://localhost:3000>. Cek status di `GET /v1/health`.

### Docker

```bash
docker compose up --build
```

Compose menjalankan Redis, sidecar cloudscraper, dan API.

## Konfigurasi

Semua konfigurasi lewat environment. Contoh lengkap ada di `.env.example`.

| Variable | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port API |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Koneksi Redis |
| `LK21_URL` | `https://tv9.nontondrama.my` | Base sumber utama |
| `LK21_MOVIES_URL` | `https://tv9.nontondrama.my` | Base daftar film |
| `LK21_SEARCH_URL` | `https://tv9.nontondrama.my/` | Base pencarian |
| `LK21_POSTER_URL` | `https://tv9.nontondrama.my/wp-content/uploads/` | Prefix poster relatif |
| `ALLOWED_HOSTS` | kosong | Allowlist host; kosong berarti otomatis dari URL sumber |
| `ALLOW_PRIVATE_HOSTS` | `false` | Izinkan host privat, hanya untuk tes lokal |
| `CLOUDSCRAPER_ENABLED` | `true` | Pakai sidecar saat kena challenge |
| `CLOUDSCRAPER_URL` | `http://127.0.0.1:8000` | Alamat sidecar |
| `CLOUDSCRAPER_ALLOWED_HOSTS` | `*.nontondrama.my` | Host yang boleh di-fetch sidecar |
| `CLOUDSCRAPER_MAX_BYTES` | `2000000` | Batas ukuran respons sidecar |
| `CLOUDSCRAPER_BROWSER` | `chrome` | Profil browser: `chrome`, `firefox`, atau `native` |
| `CLOUDSCRAPER_DELAY` | `0` | Jeda dalam detik saat menyelesaikan challenge |
| `CLOUDSCRAPER_TOKEN` | kosong | Token `X-Auth-Token` antara API dan sidecar |
| `CACHE_TTL_SECONDS` | `1800` | TTL cache |
| `STREAM_SECRET` | acak saat boot | Secret HMAC untuk token `/stream/:token` |
| `STREAM_TOKEN_TTL_SECONDS` | `21600` | Masa berlaku token stream |
| `PUBLIC_BASE_URL` | kosong | Base absolut untuk `hls`; kosong berarti URL relatif |
| `MAX_PAGES_PER_REQUEST` | `20` | Batas `pages` per request |
| `DEFAULT_LIST_LIMIT` | `24` | Jumlah item default |

Catatan:

- Semua URL sumber memakai tv9. Poster dari `poster.assetsy.de` ditulis ulang
  ke host tv9.
- `search.php` tv9 mengembalikan halaman HTML, bukan JSON. API akan memakai
  sitemap tv9 sebagai fallback dan menyimpannya di cache selama 6 jam.
- Sidecar hanya dipanggil jika request langsung mendeteksi challenge. Sidecar
  bisa melewati challenge JS/IUAM lama, tetapi bukan Turnstile atau CAPTCHA
  interaktif.
- Isi `STREAM_SECRET` di produksi agar token stream tetap valid setelah restart.

## Endpoint

Base path `/v1`. Dokumentasi lengkap ada di [`docs/API.md`](docs/API.md).

| Endpoint | Keterangan |
| --- | --- |
| `GET /v1/health` | Status Redis dan sidecar |
| `GET /v1/home` | Bagian beranda |
| `GET /v1/latest` | Konten terbaru |
| `GET /v1/popular` | Konten populer |
| `GET /v1/rating` | Rating tertinggi |
| `GET /v1/release` | Rilis terbaru |
| `GET /v1/series` | Series terbaru |
| `GET /v1/series/:filter` | Series `ongoing`, `complete`, `west`, atau `asian` |
| `GET /v1/filters` | Struktur filter navbar |
| `GET /v1/filter?path=` | Scrape path filter tv9 |
| `GET /v1/movies/:kind` | Daftar film: `home`, `latest`, `popular`, atau `top` |
| `GET /v1/search?q=` | Pencarian |
| `GET /v1/genre/:slug` | Konten per genre |
| `GET /v1/country/:slug` | Konten per negara |
| `GET /v1/year/:year` | Konten per tahun |
| `GET /v1/movie?url=\|?slug=` | Detail film atau series |
| `GET /v1/episode?url=\|?slug=` | Detail episode |
| `GET /v1/stream?url=` | Resolve player menjadi info dan `hls` |
| `GET /stream/:token` | Proxy playlist, segmen, dan key HLS |
| `GET /v1/genres` | Daftar genre |
| `GET /v1/countries` | Daftar negara |

Endpoint daftar menerima query `page`, `pages`, dan `limit`.

Contoh:

```bash
curl 'http://localhost:3000/v1/latest?page=1&limit=12'
curl 'http://localhost:3000/v1/search?q=doctor+x'
curl 'http://localhost:3000/v1/movie?slug=kate-2026'
```

## Pengujian

```bash
npm run typecheck
npm test
```

- `tests/parsers.test.ts`: parser HTML dengan fixture.
- `tests/url-guard.test.ts`: allowlist dan SSRF guard.
- `tests/integration.test.ts`: API end-to-end dengan server mock dan Redis.
  Test ini dilewati jika `redis-server` tidak tersedia.

## Legal

Proyek ini hanya untuk keperluan pribadi dan edukasi. Hormati hak cipta dan
ketentuan layanan sumber. Penulis tidak bertanggung jawab atas penyalahgunaan.
