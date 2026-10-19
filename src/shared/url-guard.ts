import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsResolver = (hostname: string) => Promise<string[]>;

export interface UrlGuardOptions {
  allowedHosts: string[];
  allowedPorts: number[];
  allowPrivateHosts: boolean;
  resolver?: DnsResolver;
  /**
   * Skip the host allowlist check (scheme, credentials, port and private-address
   * checks still apply). Useful for validating redirect hops issued by an
   * already-allowed source.
   */
  skipAllowlist?: boolean;
}

export interface UrlGuardSuccess {
  ok: true;
  url: URL;
  addresses: string[];
}

export interface UrlGuardFailure {
  ok: false;
  code: string;
  reason: string;
}

export type UrlGuardResult = UrlGuardSuccess | UrlGuardFailure;

const defaultResolver: DnsResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

function fail(code: string, reason: string): UrlGuardFailure {
  return { ok: false, code, reason };
}

function hostMatches(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function isPrivateV4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return true;
  return V4_BLOCKED.some(([network, prefix]) => {
    const base = ipv4ToInt(network);
    if (base === null) return false;
    if (prefix === 32) return value === base;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function isPrivateV6(address: string): boolean {
  const addr = address.toLowerCase();
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateV4(mapped[1]);
  if (addr === "::1" || addr === "::") return true;
  if (addr.startsWith("2001:db8")) return true;
  const firstGroup = addr.split(":")[0] || "0";
  const value = Number.parseInt(firstGroup, 16);
  if (Number.isNaN(value)) return true;
  if ((value & 0xfe00) === 0xfc00) return true;
  if ((value & 0xffc0) === 0xfe80) return true;
  if ((value & 0xff00) === 0xff00) return true;
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  return true;
}

export async function validateUrl(
  raw: string,
  options: UrlGuardOptions,
): Promise<UrlGuardResult> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fail("empty_url", "URL is required");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("invalid_url", "URL is not valid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("invalid_scheme", "Only http and https URLs are allowed");
  }
  if (url.username || url.password) {
    return fail("credentials_not_allowed", "URL must not contain credentials");
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  if (!hostname) {
    return fail("invalid_host", "URL host is missing");
  }

  if (!options.skipAllowlist) {
    if (options.allowedHosts.length === 0) {
      return fail(
        "no_allowed_hosts",
        "No allowed hosts are configured. Set ALLOWED_HOSTS to permit a source.",
      );
    }
    if (!hostMatches(hostname, options.allowedHosts)) {
      return fail(
        "host_not_allowed",
        `Host "${hostname}" is not present in ALLOWED_HOSTS`,
      );
    }
  }

  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  if (!options.allowedPorts.includes(port)) {
    return fail("port_not_allowed", `Port ${port} is not allowed`);
  }

  const resolver = options.resolver ?? defaultResolver;
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch (error) {
      return fail(
        "dns_failure",
        `Could not resolve host "${hostname}": ${(error as Error).message}`,
      );
    }
  }

  if (addresses.length === 0) {
    return fail("dns_failure", `Host "${hostname}" did not resolve to any address`);
  }

  if (!options.allowPrivateHosts) {
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        return fail(
          "private_address_blocked",
          `Host "${hostname}" resolves to a private or reserved address (${address})`,
        );
      }
    }
  }

  return { ok: true, url, addresses };
}
