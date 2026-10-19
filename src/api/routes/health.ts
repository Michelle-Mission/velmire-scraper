import axios from "axios";
import type { FastifyInstance } from "fastify";
import { config, LK21_BASE } from "../../shared/config";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/health", async () => {
    const redisOk = await app.redis
      .ping()
      .then(() => true)
      .catch(() => false);

    let cloudscraper: "disabled" | "ok" | "unreachable" = "disabled";
    if (config.CLOUDSCRAPER_ENABLED) {
      cloudscraper = "unreachable";
      try {
        const response = await axios.get(`${config.CLOUDSCRAPER_URL}/health`, {
          timeout: 3000,
          validateStatus: () => true,
          proxy: false,
        });
        if (response.status === 200) cloudscraper = "ok";
      } catch {
        cloudscraper = "unreachable";
      }
    }

    return {
      status: redisOk ? "ok" : "degraded",
      redis: redisOk ? "ok" : "down",
      cloudscraper,
      source: LK21_BASE,
      uptime: Number(process.uptime().toFixed(2)),
      timestamp: new Date().toISOString(),
    };
  });
}
