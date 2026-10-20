import type { FastifyReply } from "fastify";
import { ScrapeError } from "../http/http";

export async function respond<T>(
  reply: FastifyReply,
  loader: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await loader();
  } catch (error) {
    if (error instanceof ScrapeError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message });
    }
    throw error;
  }
}

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ScrapeError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export function strParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
