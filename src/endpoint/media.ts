import type { GroupFile } from "../db.js";
import type { FileStore } from "../file.js";
import { authorized, readJson, send } from "./common.js";
import type { Router } from "./router.js";

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
    !file.fileId ||
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

export function registerMediaEndpoint(router: Router, files: FileStore, apiToken: string): void {
  router.post("/media", async (req, res) => {
    if (!authorized(req, res, apiToken)) return;

    let file: GroupFile;
    try {
      file = parseGroupFile(await readJson(req));
    } catch {
      send(res, 400, "Invalid file registration");
      return;
    }

    const result = files.register(file);
    send(res, 201, JSON.stringify(result), {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  const redirectFile: Parameters<Router["get"]>[1] = async (_req, res, { id }) => {
    try {
      const url = await files.getDownloadUrl(id);
      if (!url) {
        send(res, 404, "Not Found");
        return;
      }

      send(res, 302, undefined, {
        location: url,
        "cache-control": "no-store",
      });
    } catch (error) {
      console.error(`[file] failed to resolve ${id}:`, error);
      send(res, 502, "File URL refresh failed", { "cache-control": "no-store" });
    }
  };

  router.get("/media/:id", redirectFile);
  router.head("/media/:id", redirectFile);
}
