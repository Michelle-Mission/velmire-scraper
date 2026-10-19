import { describe, expect, it } from "vitest";
import { isPrivateAddress, validateUrl } from "../src/shared/url-guard";

const publicResolver = async () => ["93.184.216.34"];

const baseOptions = {
  allowedHosts: ["example.com"],
  allowedPorts: [80, 443],
  allowPrivateHosts: false,
  resolver: publicResolver,
};

describe("isPrivateAddress", () => {
  it("flags private and reserved IPv4 ranges", () => {
    for (const address of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows public IPv4 addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("flags loopback, link-local and unique-local IPv6", () => {
    for (const address of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("treats IPv4-mapped IPv6 like IPv4", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("validateUrl", () => {
  it("accepts an allowlisted public host", async () => {
    const result = await validateUrl("https://example.com/movie/1", baseOptions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.hostname).toBe("example.com");
      expect(result.addresses).toEqual(["93.184.216.34"]);
    }
  });

  it("rejects a host that is not in the allowlist", async () => {
    const result = await validateUrl("https://evil.test/x", baseOptions);
    expect(result).toMatchObject({ ok: false, code: "host_not_allowed" });
  });

  it("rejects non-http schemes", async () => {
    const result = await validateUrl("ftp://example.com/file", baseOptions);
    expect(result).toMatchObject({ ok: false, code: "invalid_scheme" });
  });

  it("rejects URLs containing credentials", async () => {
    const result = await validateUrl("https://user:pass@example.com/", baseOptions);
    expect(result).toMatchObject({ ok: false, code: "credentials_not_allowed" });
  });

  it("rejects when the allowlist is empty", async () => {
    const result = await validateUrl("https://example.com/", {
      ...baseOptions,
      allowedHosts: [],
    });
    expect(result).toMatchObject({ ok: false, code: "no_allowed_hosts" });
  });

  it("rejects a disallowed port", async () => {
    const result = await validateUrl("https://example.com:8443/", baseOptions);
    expect(result).toMatchObject({ ok: false, code: "port_not_allowed" });
  });

  it("blocks hosts that resolve to private addresses", async () => {
    const result = await validateUrl("https://example.com/", {
      ...baseOptions,
      resolver: async () => ["10.0.0.5"],
    });
    expect(result).toMatchObject({ ok: false, code: "private_address_blocked" });
  });

  it("permits private addresses only when explicitly allowed", async () => {
    const result = await validateUrl("http://127.0.0.1:8080/", {
      allowedHosts: ["127.0.0.1"],
      allowedPorts: [8080],
      allowPrivateHosts: true,
    });
    expect(result.ok).toBe(true);
  });

  it("supports wildcard subdomain allowlist entries", async () => {
    const result = await validateUrl("https://cdn.example.com/poster.jpg", {
      ...baseOptions,
      allowedHosts: ["*.example.com"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects malformed URLs", async () => {
    const result = await validateUrl("not-a-url", baseOptions);
    expect(result).toMatchObject({ ok: false, code: "invalid_url" });
  });

  it("can skip the allowlist for redirect hops while still blocking private targets", async () => {
    const allowed = await validateUrl("https://mirror.example.net/page", {
      ...baseOptions,
      skipAllowlist: true,
    });
    expect(allowed.ok).toBe(true);

    const blocked = await validateUrl("https://mirror.example.net/page", {
      ...baseOptions,
      skipAllowlist: true,
      resolver: async () => ["10.0.0.5"],
    });
    expect(blocked).toMatchObject({ ok: false, code: "private_address_blocked" });
  });
});
