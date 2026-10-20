import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type Redis from "ioredis";
import { config } from "../shared/config";
import { createRedis } from "../shared/redis";
import { registerHealthRoutes } from "./routes/health";
import { registerStreamRoutes } from "./routes/stream";
import { registerV1Routes } from "./routes/v1";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

function resolveWebRoot(): string {
  const candidates = [
    join(__dirname, "..", "..", "web"),
    join(process.cwd(), "web"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 256 * 1024,
    routerOptions: { maxParamLength: 4096 },
  });

  const redis = createRedis(config.REDIS_URL);
  app.decorate("redis", redis);

  app.addHook("onClose", async () => {
    redis.disconnect();
  });

  const corsOrigin =
    config.CORS_ORIGIN === "*"
      ? true
      : config.CORS_ORIGIN.split(",").map((value) => value.trim());

  await app.register(cors, { origin: corsOrigin });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
  });
  await app.register(fastifyStatic, {
    root: resolveWebRoot(),
    prefix: "/",
    wildcard: false,
    index: ["index.html"],
  });

  await registerHealthRoutes(app);
  await registerStreamRoutes(app);
  await registerV1Routes(app);

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/v1/")) {
      reply.code(404).send({ error: "not_found", message: "Unknown API endpoint" });
      return;
    }
    reply.code(404).send({ error: "not_found", message: "Not found" });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
      reply
        .code(status)
        .send({ error: "internal_error", message: "Internal server error" });
      return;
    }
    reply.code(status).send({
      error: (error as { code?: string }).code ?? "request_error",
      message: error.message,
    });
  });

  return app;
}
