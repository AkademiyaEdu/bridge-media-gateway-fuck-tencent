import type { ImageStore } from "../image.js";
import { authorized, readJson, send } from "./common.js";
import type { Router } from "./router.js";

function parseImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected an image URL array");

  return value.map((item) => {
    if (typeof item !== "string" || !item) throw new Error("Invalid image URL");
    return item;
  });
}

export function registerImageEndpoint(router: Router, images: ImageStore, apiToken: string): void {
  router.post("/api/images", async (req, res) => {
    if (!authorized(req, res, apiToken)) return;

    let urls: string[];
    try {
      urls = parseImageUrls(await readJson(req));
    } catch {
      send(res, 400, "Invalid request");
      return;
    }

    try {
      const result = await images.save(urls);
      send(res, 200, JSON.stringify(result), {
        "content-type": "application/json; charset=utf-8",
      });
    } catch (error) {
      console.error(`[image] failed to store ${urls.length} image(s):`, error);
      send(res, 502, "Image storage failed");
    }
  });
}
