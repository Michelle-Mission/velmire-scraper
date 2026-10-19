import Redis, { type RedisOptions } from "ioredis";

interface ConnectionParts {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

function connectionParts(url: string): ConnectionParts {
  const parsed = new URL(url);
  const parts: ConnectionParts = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
  };
  if (parsed.username) parts.username = decodeURIComponent(parsed.username);
  if (parsed.password) parts.password = decodeURIComponent(parsed.password);
  const db = parsed.pathname.replace(/^\//, "");
  if (db) parts.db = Number(db);
  if (parsed.protocol === "rediss:") parts.tls = {};
  return parts;
}

/** A dedicated ioredis client used for cache reads/writes. */
export function createRedis(url: string): Redis {
  const options: RedisOptions = {
    ...connectionParts(url),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
  return new Redis(options);
}
