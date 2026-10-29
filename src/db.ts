import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface GroupFile {
  groupId: number;
  fileId: string;
  busId: number;
}

export class MediaDatabase {
  private readonly db: DatabaseSync;
  private readonly getAvatarStatement;
  private readonly saveAvatarStatement;
  private readonly insertFileStatement;
  private readonly findFileIdStatement;
  private readonly findFileStatement;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS avatar (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS media_file (
        id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        file_id TEXT NOT NULL,
        bus_id INTEGER NOT NULL,
        UNIQUE (group_id, file_id, bus_id)
      ) STRICT;
    `);

    this.getAvatarStatement = this.db.prepare("SELECT url FROM avatar WHERE id = ?");
    this.saveAvatarStatement = this.db.prepare(`
      INSERT INTO avatar (id, url) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET url = excluded.url
    `);
    this.insertFileStatement = this.db.prepare(
      "INSERT OR IGNORE INTO media_file (id, group_id, file_id, bus_id) VALUES (?, ?, ?, ?)",
    );
    this.findFileIdStatement = this.db.prepare(
      "SELECT id FROM media_file WHERE group_id = ? AND file_id = ? AND bus_id = ?",
    );
    this.findFileStatement = this.db.prepare(
      "SELECT group_id, file_id, bus_id FROM media_file WHERE id = ?",
    );
  }

  getAvatarUrl(id: string): string | undefined {
    return (this.getAvatarStatement.get(id) as { url: string } | undefined)?.url;
  }

  saveAvatarUrl(id: string, url: string): void {
    this.saveAvatarStatement.run(id, url);
  }

  registerFile(file: GroupFile): string {
    this.insertFileStatement.run(randomUUID(), file.groupId, file.fileId, file.busId);
    const row = this.findFileIdStatement.get(file.groupId, file.fileId, file.busId) as {
      id: string;
    };
    return row.id;
  }

  getFile(id: string): GroupFile | undefined {
    const row = this.findFileStatement.get(id) as
      | { group_id: number; file_id: string; bus_id: number }
      | undefined;

    return row && {
      groupId: row.group_id,
      fileId: row.file_id,
      busId: row.bus_id,
    };
  }

  close(): void {
    this.db.close();
  }
}
