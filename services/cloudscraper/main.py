"""
Velmire CloudScraper sidecar.

A tiny HTTP service (Python standard library only) that performs a single
request through the `cloudscraper` library. Node.js delegates here only when it
detects a Cloudflare-style challenge on the direct request.

It never claims a challenge is solvable: if the challenge is still present in
the response, the request is reported as failed with a clear reason.

Endpoints
---------
GET  /health  -> {"status": "ok", ...}
POST /fetch   -> {"ok": bool, "status_code": int, "url": str, "html": str,
                  "challenge": {"detected": bool, "solved": bool, "type": str},
                  "error": str|None}
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from urllib.parse import urlparse

try:
    import cloudscraper
except ImportError:  # pragma: no cover - guidance for a missing dependency
    sys.stderr.write(
        "cloudscraper is not installed. Run: pip install -r requirements.txt\n"
    )
    raise

try:
    import requests
except ImportError:  # cloudscraper normally depends on requests
    requests = None  # type: ignore[assignment]

HOST = os.environ.get("CLOUDSCRAPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLOUDSCRAPER_PORT", "8000"))
AUTH_TOKEN = os.environ.get("CLOUDSCRAPER_TOKEN", "").strip()
MAX_BYTES_DEFAULT = int(os.environ.get("CLOUDSCRAPER_MAX_BYTES", "2000000"))
DEFAULT_TIMEOUT_MS = int(os.environ.get("CLOUDSCRAPER_TIMEOUT_MS", "30000"))
ALLOWED_HOSTS = [
    host.strip().lower()
    for host in os.environ.get("CLOUDSCRAPER_ALLOWED_HOSTS", "").split(",")
    if host.strip()
]
ALLOW_PRIVATE = os.environ.get("CLOUDSCRAPER_ALLOW_PRIVATE", "false").lower() in {
    "1",
    "true",
    "yes",
    "on",
}

CHALLENGE_MARKERS = (
    "just a moment",
    "checking your browser",
    "cf-chl",
    "__cf_chl",
    "cf_challenge",
    "attention required",
    "enable javascript and cookies",
)

# These strings also appear on healthy Cloudflare pages (e.g. the jsd script),
# so they only count as a challenge when the status is suspicious.
WEAK_CHALLENGE_MARKERS = (
    "challenge-platform",
    "turnstile",
)

BROWSERS = {"chrome", "firefox", "native"}
BROWSER = os.environ.get("CLOUDSCRAPER_BROWSER", "chrome").strip().lower()
if BROWSER not in BROWSERS:
    BROWSER = "chrome"
try:
    DELAY = max(0.0, float(os.environ.get("CLOUDSCRAPER_DELAY", "0") or 0))
except ValueError:
    DELAY = 0.0

_scraper: Optional[Any] = None
_scraper_lock = threading.Lock()


def get_scraper() -> Any:
    global _scraper
    if _scraper is None:
        with _scraper_lock:
            if _scraper is None:
                options: dict[str, Any] = {
                    "browser": {
                        "browser": BROWSER,
                        "platform": "windows",
                        "mobile": False,
                    },
                }
                if DELAY > 0:
                    options["delay"] = DELAY
                _scraper = cloudscraper.create_scraper(**options)
    return _scraper


def host_allowed(hostname: str) -> bool:
    if not ALLOWED_HOSTS:
        return True
    hostname = hostname.lower()
    for pattern in ALLOWED_HOSTS:
        if pattern.startswith("*."):
            suffix = pattern[1:]
            if hostname.endswith(suffix) and len(hostname) > len(suffix):
                return True
        elif hostname == pattern:
            return True
    return False


def assert_safe_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("only http and https URLs are allowed")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL host is missing")
    if not host_allowed(hostname):
        raise ValueError(f'host "{hostname}" is not in CLOUDSCRAPER_ALLOWED_HOSTS')
    if ALLOW_PRIVATE:
        return
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(hostname, None)}
    except socket.gaierror as exc:
        raise ValueError(f"could not resolve host: {exc}") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError(f"host resolves to a private address ({address})")


def detect_challenge(status_code: int, headers: dict[str, Any], body: str) -> dict[str, Any]:
    lowered = body[:30000].lower()
    header_map = {str(key).lower(): str(value) for key, value in headers.items()}
    strong = any(needle in lowered for needle in CHALLENGE_MARKERS)
    weak = any(needle in lowered for needle in WEAK_CHALLENGE_MARKERS)
    cf_ray = "cf-ray" in header_map
    mitigated = header_map.get("cf-mitigated", "").lower()
    suspicious = status_code in (403, 429, 503)
    detected = strong or mitigated == "challenge" or (cf_ray and suspicious) or (weak and suspicious)
    solved = not strong and status_code < 400
    return {
        "detected": detected,
        "solved": solved,
        "type": "cloudflare" if detected else None,
    }


def read_limited(response: Any, max_bytes: int) -> str:
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=65536):
        if not chunk:
            continue
        remaining = max_bytes - total
        if remaining <= 0:
            break
        piece = chunk[:remaining]
        chunks.append(piece)
        total += len(piece)
        if total >= max_bytes:
            break
    encoding = response.encoding or response.apparent_encoding or "utf-8"
    return b"".join(chunks).decode(encoding, errors="replace")


def do_fetch(payload: dict[str, Any], token: Optional[str]) -> tuple[int, dict[str, Any]]:
    if AUTH_TOKEN and token != AUTH_TOKEN:
        return 401, {"ok": False, "challenge": {"detected": False, "solved": False}, "error": "invalid or missing X-Auth-Token"}

    url = payload.get("url")
    if not isinstance(url, str) or not url:
        return 400, {"ok": False, "challenge": {"detected": False, "solved": False}, "error": "field 'url' is required"}

    method = str(payload.get("method", "GET")).upper()
    if method != "GET":
        return 400, {"ok": False, "challenge": {"detected": False, "solved": False}, "error": "only GET is supported"}

    timeout_ms = int(payload.get("timeout_ms") or DEFAULT_TIMEOUT_MS)
    max_bytes = int(payload.get("max_bytes") or MAX_BYTES_DEFAULT)
    user_agent = payload.get("user_agent") or (
        "Mozilla/5.0 (compatible; VelmireScraper/1.0; +https://localhost)"
    )

    try:
        assert_safe_url(url)
    except ValueError as exc:
        return 400, {"ok": False, "challenge": {"detected": False, "solved": False}, "error": f"blocked: {exc}"}

    headers = {
        "User-Agent": user_agent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    extra = payload.get("headers")
    if isinstance(extra, dict):
        headers.update({str(k): str(v) for k, v in extra.items()})
    if not any(key.lower() == "referer" for key in headers):
        target = urlparse(url)
        headers["Referer"] = f"{target.scheme}://{target.netloc}/"

    challenge_fail = {"detected": True, "solved": False, "type": "cloudflare"}
    try:
        response = get_scraper().request(
            "GET",
            url,
            headers=headers,
            timeout=timeout_ms / 1000,
            allow_redirects=True,
            stream=True,
        )
    except Exception as exc:  # noqa: BLE001 - report any solver failure clearly
        name = type(exc).__name__
        return 502, {"ok": False, "challenge": challenge_fail, "error": f"cloudscraper request failed: {name}: {exc}"}

    try:
        body = read_limited(response, max_bytes)
        status_code = response.status_code
        final_url = str(response.url)
        response_headers = dict(response.headers)
    finally:
        response.close()

    challenge = detect_challenge(status_code, response_headers, body)
    ok = status_code < 400 and challenge["solved"]

    error: Optional[str] = None
    if not ok:
        if challenge["detected"] and not challenge["solved"]:
            error = "Cloudflare challenge is still present after the cloudscraper attempt"
        else:
            error = f"target responded with HTTP {status_code}"

    return 200, {
        "ok": ok,
        "status_code": status_code,
        "url": final_url,
        "html": body,
        "challenge": challenge,
        "engine": "cloudscraper",
        "error": error,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "VelmireCloudscraper/1.0"
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if urlparse(self.path).path == "/health":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "engine": "cloudscraper",
                    "cloudscraper_version": getattr(cloudscraper, "__version__", "unknown"),
                    "browser": BROWSER,
                    "delay": DELAY,
                    "allowlist_configured": bool(ALLOWED_HOSTS),
                    "auth_required": bool(AUTH_TOKEN),
                },
            )
        else:
            self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        if urlparse(self.path).path != "/fetch":
            self._send_json(404, {"error": "not_found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""

        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "invalid JSON body"})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"ok": False, "error": "body must be a JSON object"})
            return

        status, result = do_fetch(payload, self.headers.get("X-Auth-Token"))
        self._send_json(status, result)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[cloudscraper] " + (fmt % args) + "\n")


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    sys.stderr.write(
        f"[cloudscraper] listening on http://{HOST}:{PORT} "
        f"(allowlist={'configured' if ALLOWED_HOSTS else 'open'})\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
