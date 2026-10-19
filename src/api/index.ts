import { buildApp } from "./app";
import { config } from "../shared/config";

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info(
      `velmire-scraper API listening on http://${config.HOST}:${config.PORT}`,
    );
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
