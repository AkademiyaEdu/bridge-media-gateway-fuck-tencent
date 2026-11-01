import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class MediaDatabase {
  private readonly db: DatabaseSync;
  public readonly avatarUrlById;
  public readonly upsertAvatar;
  public readonly insertFile;
  public readonly updateFileName;
  public readonly fileIdByIdentity;
  public readonly fileById;
  public readonly insertVideo;
  public readonly videoIdByMessageId;
  public readonly videoMessageIdById;
  public readonly insertForwardVideo;
  public readonly forwardVideoIdByIdentity;
  public readonly forwardVideoById;

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
        file_name TEXT,
        UNIQUE (group_id, file_id, bus_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS media_video (
        id TEXT PRIMARY KEY,
        message_id INTEGER NOT NULL UNIQUE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS media_forward_video (
        id TEXT PRIMARY KEY,
        forward_id TEXT NOT NULL,
        node_index INTEGER NOT NULL,
        UNIQUE (forward_id, node_index)
      ) STRICT;
    `);

    // Upgrade the existing SQLite table without changing file IDs.
    if (!this.db.prepare("PRAGMA table_info(media_file)").all().some((column) => column.name === "file_name")) {
      this.db.exec("ALTER TABLE media_file ADD COLUMN file_name TEXT");
    }

    this.avatarUrlById = this.db.prepare("SELECT url FROM avatar WHERE id = ?");
    this.upsertAvatar = this.db.prepare(`
      INSERT INTO avatar (id, url) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET url = excluded.url
    `);
    this.insertFile = this.db.prepare(
      "INSERT OR IGNORE INTO media_file (id, group_id, file_id, bus_id, file_name) VALUES (?, ?, ?, ?, ?)",
    );
    this.updateFileName = this.db.prepare("UPDATE media_file SET file_name = ? WHERE id = ?");
    this.fileIdByIdentity = this.db.prepare(
      "SELECT id FROM media_file WHERE group_id = ? AND file_id = ? AND bus_id = ?",
    );
    this.fileById = this.db.prepare(
      "SELECT group_id, file_id, bus_id, file_name FROM media_file WHERE id = ?",
    );
    this.insertVideo = this.db.prepare(
      "INSERT OR IGNORE INTO media_video (id, message_id) VALUES (?, ?)",
    );
    this.videoIdByMessageId = this.db.prepare(
      "SELECT id FROM media_video WHERE message_id = ?",
    );
    this.videoMessageIdById = this.db.prepare(
      "SELECT message_id FROM media_video WHERE id = ?",
    );
    this.insertForwardVideo = this.db.prepare(
      "INSERT OR IGNORE INTO media_forward_video (id, forward_id, node_index) VALUES (?, ?, ?)",
    );
    this.forwardVideoIdByIdentity = this.db.prepare(
      "SELECT id FROM media_forward_video WHERE forward_id = ? AND node_index = ?",
    );
    this.forwardVideoById = this.db.prepare(
      "SELECT forward_id, node_index FROM media_forward_video WHERE id = ?",
    );
  }

  close(): void {
    this.db.close();
  }
}
