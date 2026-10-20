import type { FastifyInstance } from "fastify";
import { proxyMedia, resolveStream, verifyStreamToken } from "../../player/player";
import { respond, sendError, strParam } from "../respond";

export async function registerStreamRoutes(app: FastifyInstance): Promise<void> {
  // Resolve an LK21 player wrapper into a same-origin HLS URL.
  app.get("/v1/stream", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const url = strParam(q.url);
    if (!url) {
      return reply
        .code(400)
        .send({ error: "missing_url", message: "Query parameter `url` is required" });
    }
    return respond(reply, () => resolveStream(app.redis, url));
  });

  // Signed media proxy: playlists are rewritten to this same endpoint, so the
  // browser only ever sees one stable, same-origin URL.
  app.get("/stream/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      const url = verifyStreamToken(token);
      const result = await proxyMedia(url, request.headers.range);
      reply.code(result.status).header("Content-Type", result.contentType);
      if (result.contentRange) reply.header("Content-Range", result.contentRange);
      if (result.acceptRanges) reply.header("Accept-Ranges", result.acceptRanges);
      reply.header(
        "Cache-Control",
        result.contentType.includes("mpegurl") ? "no-store" : "public, max-age=300",
      );
      return reply.send(result.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
