import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { GroupFile } from "./db.js";
import type { FileStore } from "./file.js";
import type { ImageStore } from "./image.js";

const MAX_BODY_SIZE = 64 * 1024;
const MEDIA_ID_PATTERN = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function authorized(req: IncomingMessage, token: string): boolean {
  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_SIZE) {
      throw new Error("Request body too large");
    }

    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseImageURLs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected an image URL array");
  }

  return value.map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("Invalid image URL");
    }

    return item;
  });
}

function parseGroupFile(value: unknown): GroupFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a file object");
  }

  const file = value as Record<string, unknown>;
  const busId = file.busId === undefined ? 102 : file.busId;

  if (
    file.type !== "file" ||
    !Number.isSafeInteger(file.groupId) ||
    (file.groupId as number) <= 0 ||
    typeof file.fileId !== "string" ||
    file.fileId.length === 0 ||
    !Number.isSafeInteger(busId) ||
    (busId as number) < 0
  ) {
    throw new Error("Invalid file registration");
  }

  return {
    groupId: file.groupId as number,
    fileId: file.fileId,
    busId: busId as number,
  };
}

function send(
  res: ServerResponse,
  status: number,
  body?: string,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, headers);
  res.end(body);
}

export function createStorageServer(
  images: ImageStore,
  files: FileStore,
  apiToken: string,
) {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "GET" && path === "/healthz") {
      send(res, 204);
      return;
    }

    const mediaId = path.match(MEDIA_ID_PATTERN)?.[1];
    if ((req.method === "GET" || req.method === "HEAD") && mediaId) {
      try {
        const url = await files.getDownloadUrl(mediaId);
        if (!url) {
          send(res, 404, "Not Found");
          return;
        }

        send(res, 302, undefined, {
          location: url,
          "cache-control": "no-store",
        });
      } catch (error) {
        console.error(`[file] failed to resolve ${mediaId}:`, error);
        send(res, 502, "File URL refresh failed", { "cache-control": "no-store" });
      }
      return;
    }

    if (req.method !== "POST" || (path !== "/api/images" && path !== "/media")) {
      send(res, 404, "Not Found");
      return;
    }

    if (!authorized(req, apiToken)) {
      send(res, 401, "Unauthorized", {
        "www-authenticate": "Bearer",
      });
      return;
    }

    if (path === "/media") {
      try {
        const file = parseGroupFile(await readJson(req));
        const result = files.register(file);
        send(res, 201, JSON.stringify(result), {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
      } catch {
        send(res, 400, "Invalid file registration");
      }
      return;
    }

    let body: string[];

    try {
      body = parseImageURLs(await readJson(req));
    } catch {
      send(res, 400, "Invalid request");
      return;
    }

    try {
      const urls = await images.save(body);

      send(res, 200, JSON.stringify(urls), {
        "content-type": "application/json; charset=utf-8",
      });
    } catch (error) {
      console.error(`[image] failed to store ${body.length} image(s):`, error);
      send(res, 502, "Image storage failed");
    }
  });
}
