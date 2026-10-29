import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface GroupFile {
  groupId: number;
  fileId: string;
  busId: number;
}

export class FileStore {
  private readonly db: DatabaseSync;
  private readonly insertFile;
  private readonly findFile;
  private readonly findFileId;

  constructor(
    dbPath: string,
    private readonly publicBaseUrl: string,
    private readonly snowlumaUrl: string,
    private readonly snowlumaToken?: string,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_file (
        id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        file_id TEXT NOT NULL,
        bus_id INTEGER NOT NULL,
        UNIQUE (group_id, file_id, bus_id)
      ) STRICT
    `);
    this.insertFile = this.db.prepare(
      "INSERT OR IGNORE INTO media_file (id, group_id, file_id, bus_id) VALUES (?, ?, ?, ?)",
    );
    this.findFile = this.db.prepare(
      "SELECT group_id, file_id, bus_id FROM media_file WHERE id = ?",
    );
    this.findFileId = this.db.prepare(
      "SELECT id FROM media_file WHERE group_id = ? AND file_id = ? AND bus_id = ?",
    );
  }

  register(file: GroupFile): { id: string; url: string } {
    this.insertFile.run(randomUUID(), file.groupId, file.fileId, file.busId);
    const row = this.findFileId.get(file.groupId, file.fileId, file.busId) as {
      id: string;
    };

    return {
      id: row.id,
      url: new URL(`/media/${row.id}`, this.publicBaseUrl).toString(),
    };
  }

  async getDownloadUrl(id: string): Promise<string | null> {
    const file = this.findFile.get(id) as
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

  close(): void {
    this.db.close();
  }
}
