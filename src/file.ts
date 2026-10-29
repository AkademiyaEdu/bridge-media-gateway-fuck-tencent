import type { GroupFile, MediaDatabase } from "./db.js";

export class FileStore {
  constructor(
    private readonly db: MediaDatabase,
    private readonly publicBaseUrl: string,
    private readonly snowlumaUrl: string,
    private readonly snowlumaToken?: string,
  ) {}

  register(file: GroupFile): { id: string; url: string } {
    const id = this.db.registerFile(file);
    return {
      id,
      url: new URL(`/media/${id}`, this.publicBaseUrl).toString(),
    };
  }

  async getDownloadUrl(id: string): Promise<string | null> {
    const file = this.db.getFile(id);
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
          group_id: file.groupId,
          file_id: file.fileId,
          busid: file.busId,
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
