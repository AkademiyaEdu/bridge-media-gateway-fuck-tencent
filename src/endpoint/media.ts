import type { MediaStore, GroupFile } from "../store/media.js";
import { authorized, readJson, send } from "./common.js";
import type { EndpointHandler, Router } from "./router.js";

type MediaRegistration =
  | ({ type: "file" } & GroupFile)
  | { type: "video"; messageId: number };

function parseMediaRegistration(value: unknown): MediaRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a media object");
  }

  const { type, groupId, fileId, busId: providedBusId, messageId } =
    value as Record<string, unknown>;

  if (type === "video") {
    if (typeof messageId !== "number" || !Number.isSafeInteger(messageId)) {
      throw new Error("Invalid video registration");
    }
    return { type, messageId };
  }

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

  return { type, groupId, fileId, busId };
}

export function registerMediaEndpoint(router: Router, media: MediaStore, apiToken: string): void {
  router.post("/api/media", async (req, res) => {
    if (!authorized(req, res, apiToken)) return;

    let registration: MediaRegistration;
    try {
      registration = parseMediaRegistration(await readJson(req));
    } catch {
      send(res, 400, "Invalid media registration");
      return;
    }

    const result = registration.type === "file"
      ? media.registerFile(registration)
      : media.registerVideo(registration.messageId);
    send(res, 201, JSON.stringify(result), {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  const redirectMedia: EndpointHandler = async (_req, res, { id }) => {
    try {
      const url = await media.getDownloadUrl(id);
      if (!url) {
        send(res, 404, "Not Found");
        return;
      }

      send(res, 302, undefined, {
        location: url,
        "cache-control": "no-store",
      });
    } catch (error) {
      console.error(`[media] failed to resolve ${id}:`, error);
      send(res, 502, "Media URL refresh failed", { "cache-control": "no-store" });
    }
  };

  router.get("/media/:id", redirectMedia);
  router.head("/media/:id", redirectMedia);
}
