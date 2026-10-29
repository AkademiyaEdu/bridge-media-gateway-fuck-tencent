import { send } from "./common.js";
import type { Router } from "./router.js";

export function registerHealthEndpoint(router: Router): void {
  router.get("/healthz", (_req, res) => send(res, 204));
}
