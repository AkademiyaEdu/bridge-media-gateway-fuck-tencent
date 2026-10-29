import type { FileStore, GroupFile } from "../store/file.js";
import { authorized, readJson, send } from "./common.js";
import type { EndpointHandler, Router } from "./router.js";

function parseGroupFile(value: unknown): GroupFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a file object");
  }

  const { type, groupId, fileId, busId: providedBusId } = value as Record<string, unknown>;
  const busId = providedBusId === undefined ? 102 : providedBusId;

  if (
    type !== "file" ||
    typeof groupId !== "number" ||
    !Number.isSafeInteger(groupId) ||
    groupId <= 0 ||
    typeof fileId !== "string" ||
    !fileId ||
    typeof busId !== "number" ||
    !Number.isSafeInteger(busId) ||
    busId < 0
  ) {
    throw new Error("Invalid file registration");
  }

  return { groupId, fileId, busId };
}

export function registerMediaEndpoint(router: Router, files: FileStore, apiToken: string): void {
  router.post("/api/media", async (req, res) => {
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

  const redirectFile: EndpointHandler = async (_req, res, { id }) => {
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
