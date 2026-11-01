import { randomInt } from "node:crypto";
import type { MediaDatabase } from "../db.js";

export interface GroupFile {
  groupId: number;
  fileId: string;
  busId: number;
  fileName?: string;
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

export class MediaStore {
  private readonly downloadUrlCache = new Map<string, { url: string; expiresAt: number }>();
  private readonly pendingUrlRefreshes = new Map<string, Promise<string | null>>();

  constructor(
    private readonly db: MediaDatabase,
    private readonly publicBaseUrl: string,
    private readonly onebotUrl: string,
    private readonly onebotToken?: string,
  ) {}

  registerFile(file: GroupFile): { id: string; url: string } {
    const existing = this.db.fileIdByIdentity.get(file.groupId, file.fileId, file.busId) as
      | { id: string }
      | undefined;

    let id = existing?.id;
    if (id) {
      if (file.fileName) {
        this.db.updateFileName.run(file.fileName, id);
        this.downloadUrlCache.delete(id);
      }
    } else {
      for (;;) {
        id = generateMediaId();
        if (this.db.insertFile.run(id, file.groupId, file.fileId, file.busId, file.fileName ?? null).changes) {
          break;
        }
      }
    }

    return {
      id,
      url: new URL(`/media/${id}`, this.publicBaseUrl).toString(),
    };
  }

  registerVideo(messageId: number): { id: string; url: string } {
    const existing = this.db.videoIdByMessageId.get(messageId) as { id: string } | undefined;

    let id = existing?.id;
    if (!id) {
      for (;;) {
        id = generateMediaId();
        if (this.db.insertVideo.run(id, messageId).changes) break;
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
      | { group_id: number; file_id: string; bus_id: number; file_name: string | null }
      | undefined;

    let rawUrl: string | undefined;
    if (file) {
      const data = await this.requestOnebot<{ url?: string }>("get_group_file_url", {
        group_id: file.group_id,
        file_id: file.file_id,
        busid: file.bus_id,
      });
      rawUrl = data.url;
    } else {
      const video = this.db.videoMessageIdById.get(id) as
        | { message_id: number }
        | undefined;
      if (!video) return null;

      const data = await this.requestOnebot<{
        message?: { type: string; data?: { url?: string } }[];
      }>("get_msg", { message_id: video.message_id });
      rawUrl = data.message?.find((segment) => segment.type === "video")?.data?.url;
    }

    if (typeof rawUrl !== "string") {
      throw new Error("OneBot returned no media URL");
    }
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") {
      throw new Error("OneBot returned a non-HTTPS media URL");
    }
    if (file) {
      // The file may have been re-registered while OneBot was refreshing its URL.
      const latestFile = this.db.fileById.get(id) as { file_name: string | null };
      if (latestFile.file_name) {
        url.searchParams.set("fname", latestFile.file_name);
      }
    } else {
      url.searchParams.set("filename", "placeholder.mp4");
    }
    return url.toString();
  }

  private async requestOnebot<T>(action: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.onebotUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.onebotToken
          ? { authorization: `Bearer ${this.onebotToken}` }
          : {}),
      },
      body: JSON.stringify({ action, params }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`OneBot HTTP ${response.status}`);
    }

    const result = (await response.json()) as {
      status?: string;
      retcode?: number;
      wording?: string;
      data?: T;
    };
    if (result?.status !== "ok" || !result.data) {
      throw new Error(
        `OneBot ${action} failed: ${result?.wording ?? result?.retcode ?? "invalid response"}`,
      );
    }
    return result.data;
  }
}
