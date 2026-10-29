import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_SIZE = 64 * 1024;

export function authorized(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);

  if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
    return true;
  }

  send(res, 401, "Unauthorized", { "www-authenticate": "Bearer" });
  return false;
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_SIZE) throw new Error("Request body too large");
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function send(
  res: ServerResponse,
  status: number,
  body?: string,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, headers);
  res.end(body);
}
