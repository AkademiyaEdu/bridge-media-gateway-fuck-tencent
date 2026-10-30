import { randomInt } from "node:crypto";
import type { MediaDatabase } from "../db.js";

export interface GroupFile {
  groupId: number;
  fileId: string;
  busId: number;
}

const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateMediaId(): string {
  let id = "";
  for (let index = 0; index < 11; index++) {
    id += BASE62[randomInt(BASE62.length)];
  }
  return id;
}

const DOWNLOAD_URL_CACHE_TTL_MS = 5 * 60 * 1000;

export class FileStore {
  private readonly downloadUrlCache = new Map<string, { url: string; expiresAt: number }>();
  private readonly pendingUrlRefreshes = new Map<string, Promise<string | null>>();

  constructor(
    private readonly db: MediaDatabase,
    private readonly publicBaseUrl: string,
    private readonly snowlumaUrl: string,
    private readonly snowlumaToken?: string,
  ) {}

  register(file: GroupFile): { id: string; url: string } {
    const existing = this.db.fileIdByIdentity.get(file.groupId, file.fileId, file.busId) as
      | { id: string }
      | undefined;

    let id = existing?.id;
    if (!id) {
      for (;;) {
        id = generateMediaId();
        if (this.db.insertFile.run(id, file.groupId, file.fileId, file.busId).changes) {
          break;
        }
      }
    }

    return {
      id,
      url: new URL(`/media/${id}`, this.publicBaseUrl).toString(),
    };
  }

  getDownloadUrl(id: string): Promise<string | null> {
    const cached = this.downloadUrlCache.get(id);
    if (cached) {
      if (cached.expiresAt > Date.now()) return Promise.resolve(cached.url);
      this.downloadUrlCache.delete(id);
    }

    const pending = this.pendingUrlRefreshes.get(id);
    if (pending) return pending;

    const request = this.refreshDownloadUrl(id)
      .then((url) => {
        if (url) {
          this.downloadUrlCache.set(id, {
            url,
            expiresAt: Date.now() + DOWNLOAD_URL_CACHE_TTL_MS,
          });
        }
        return url;
      })
      .finally(() => this.pendingUrlRefreshes.delete(id));

    this.pendingUrlRefreshes.set(id, request);
    return request;
  }

  private async refreshDownloadUrl(id: string): Promise<string | null> {
    const file = this.db.fileById.get(id) as
      | { group_id: number; file_id: string; bus_id: number }
      | undefined;
    if (!file) return null;

    const response = await fetch(this.snowlumaUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.snowlumaToken
          ? { authorization: `Bearer ${this.snowlumaToken}` }
          : {}),
      },
      body: JSON.stringify({
        action: "get_group_file_url",
        params: {
          group_id: file.group_id,
          file_id: file.file_id,
          busid: file.bus_id,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`SnowLuma HTTP ${response.status}`);
    }

    const result = (await response.json()) as {
      status?: string;
      retcode?: number;
      wording?: string;
      data?: { url?: string };
    };

    if (result?.status !== "ok" || typeof result.data?.url !== "string") {
      throw new Error(
        `SnowLuma get_group_file_url failed: ${result?.wording ?? result?.retcode ?? "invalid response"}`,
      );
    }

    const url = new URL(result.data.url);
    if (url.protocol !== "https:") {
      throw new Error("SnowLuma returned a non-HTTPS file URL");
    }
    return url.toString();
  }
}
