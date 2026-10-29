import { createServer } from "node:http";
import type { FileStore } from "./store/file.js";
import type { ImageStore } from "./store/image.js";
import { registerHealthEndpoint } from "./endpoint/health.js";
import { registerImageEndpoint } from "./endpoint/image.js";
import { registerMediaEndpoint } from "./endpoint/media.js";
import { Router } from "./endpoint/router.js";

export function createStorageServer(images: ImageStore, files: FileStore, apiToken: string) {
  const router = new Router();
  registerHealthEndpoint(router);
  registerImageEndpoint(router, images, apiToken);
  registerMediaEndpoint(router, files, apiToken);
  return createServer((req, res) => {
    void router.handle(req, res).catch((error) => {
      console.error("[http] request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });
  });
}
