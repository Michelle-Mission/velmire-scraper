import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  castHash,
  decryptCastPlayback,
  parseCastEmbed,
  signStreamToken,
  solveCastPow,
  verifyStreamToken,
} from "../src/player/player";

function leadingZeroBits(words: Uint32Array): number {
  let bits = 0;
  for (const word of words) {
    if (word === 0) {
      bits += 32;
      continue;
    }
    return bits + Math.clz32(word);
  }
  return bits;
}

describe("solveCastPow", () => {
  it("returns a nonce with the requested leading zero bits", async () => {
    const nonce = "0123456789abcdef";
    const solution = await solveCastPow(nonce, 6);
    expect(solution).not.toBeNull();
    const bytes = Uint8Array.from(`${nonce}:${solution}`, (char) => char.charCodeAt(0) & 255);
    expect(leadingZeroBits(castHash(bytes))).toBeGreaterThanOrEqual(6);
  });

  it("returns zero when no work is required", async () => {
    expect(await solveCastPow("abc", 0)).toBe("0");
  });
});

describe("decryptCastPlayback", () => {
  const parts = Array.from({ length: 30 }, (_value, index) =>
    Buffer.alloc(16, index + 1).toString("base64url"),
  );
  const key = Buffer.concat([
    Buffer.from(parts[1], "base64url"),
    Buffer.from(parts[28], "base64url"),
  ]);

  function encrypt(payload: unknown): { iv: string; payload: string } {
    const iv = Buffer.alloc(12, 9);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return {
      iv: iv.toString("base64url"),
      payload: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64url"),
    };
  }

  it("decrypts the version-selected key parts", () => {
    const encrypted = encrypt({ sources: [{ url: "https://cdn.example/master.m3u8", height: 1080 }] });
    expect(
      decryptCastPlayback({
        algorithm: "AES-256-GCM",
        key_parts: parts,
        version: "2",
        iv: encrypted.iv,
        payload: encrypted.payload,
      }),
    ).toEqual({ sources: [{ url: "https://cdn.example/master.m3u8", height: 1080 }] });
  });

  it("rejects an unknown key version", () => {
    expect(() =>
      decryptCastPlayback({
        key_parts: parts,
        version: "99",
        iv: "AAAA",
        payload: "AAAA",
      }),
    ).toThrow(/invalid cast playback key/);
  });
});

describe("parseCastEmbed", () => {
  it("reads the code from an /e/ embed URL", () => {
    expect(parseCastEmbed("https://mfw09.org/e/ikm27j86y83s")).toEqual({
      origin: "https://mfw09.org",
      code: "ikm27j86y83s",
    });
  });

  it("rejects URLs without a share code", () => {
    expect(parseCastEmbed("https://mfw09.org/")).toBeNull();
    expect(parseCastEmbed("not a url")).toBeNull();
  });
});

describe("signed stream tokens", () => {
  it("round-trips the upstream URL", () => {
    const token = signStreamToken("https://cdn.example/playlist.m3u8");
    expect(verifyStreamToken(token)).toBe("https://cdn.example/playlist.m3u8");
  });
});
