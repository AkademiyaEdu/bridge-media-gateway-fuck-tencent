import type { IncomingMessage, ServerResponse } from "node:http";
import { send } from "./common.js";

export type EndpointHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  parameterNames: string[];
  handler: EndpointHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  get(path: string, handler: EndpointHandler): void {
    this.add("GET", path, handler);
  }

  head(path: string, handler: EndpointHandler): void {
    this.add("HEAD", path, handler);
  }

  post(path: string, handler: EndpointHandler): void {
    this.add("POST", path, handler);
  }

  private add(method: string, path: string, handler: EndpointHandler): void {
    const parameterNames = [...path.matchAll(/:([a-zA-Z]+)/g)].map((match) => match[1]);
    const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`);
    this.routes.push({ method, pattern, parameterNames, handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    for (const route of this.routes) {
      if (req.method !== route.method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;

      const params = Object.fromEntries(
        route.parameterNames.map((name, index) => [name, match[index + 1]]),
      );
      await route.handler(req, res, params);
      return;
    }

    send(res, 404, "Not Found");
  }
}
