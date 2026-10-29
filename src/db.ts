import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class MediaDatabase {
  private readonly db: DatabaseSync;
  public readonly getAvatar;
  public readonly saveAvatar;
  public readonly insertFile;
  public readonly findFileId;
  public readonly findFile;

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

    this.getAvatar = this.db.prepare("SELECT url FROM avatar WHERE id = ?");
    this.saveAvatar = this.db.prepare(`
      INSERT INTO avatar (id, url) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET url = excluded.url
    `);
    this.insertFile = this.db.prepare(
      "INSERT OR IGNORE INTO media_file (id, group_id, file_id, bus_id) VALUES (?, ?, ?, ?)",
    );
    this.findFileId = this.db.prepare(
      "SELECT id FROM media_file WHERE group_id = ? AND file_id = ? AND bus_id = ?",
    );
    this.findFile = this.db.prepare(
      "SELECT group_id, file_id, bus_id FROM media_file WHERE id = ?",
    );
  }

  close(): void {
    this.db.close();
  }
}
