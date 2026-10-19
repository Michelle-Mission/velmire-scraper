import { createHash } from "node:crypto";
import type Redis from "ioredis";
import { config } from "./config";

const PREFIX = "velmire:v1";

export function cacheKey(parts: Array<string | number | null | undefined>): string {
  const digest = createHash("sha1")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex")
    .slice(0, 24);
  return `${PREFIX}:${digest}`;
}

export async function getJson<T>(redis: Redis, key: string): Promise<T | null> {
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    await redis.del(key).catch(() => undefined);
    return null;
  }
}

export async function setJson(
  redis: Redis,
  key: string,
  value: unknown,
  ttlSeconds = config.CACHE_TTL_SECONDS,
): Promise<void> {
  if (ttlSeconds <= 0) return;
  await redis
    .set(key, JSON.stringify(value), "EX", ttlSeconds)
    .catch(() => undefined);
}

export async function remember<T>(
  redis: Redis,
  key: string,
  loader: () => Promise<T>,
  ttlSeconds = config.CACHE_TTL_SECONDS,
): Promise<T> {
  const cached = await getJson<T>(redis, key);
  if (cached !== null) return cached;
  const value = await loader();
  await setJson(redis, key, value, ttlSeconds);
  return value;
}
