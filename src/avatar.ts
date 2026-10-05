import { randomUUID } from "node:crypto";
import { access, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { User } from "discord.js";
import { AvatarDB } from "./db.js";

export function avatarKey(url: string): string {
  const path = new URL(url).pathname;
  return path.match(/^\/avatars\/\d+\/((?:a_)?[0-9a-f]{32})\.[a-z0-9]+$/i)?.[1]
    ?? url;
}

export class AvatarStore {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly latest = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly db: AvatarDB,
  ) {}

  save(user: Pick<User, "id" | "displayAvatarURL">): Promise<void> {
    const id = user.id;
    const url = user.displayAvatarURL({ extension: "webp", size: 32 });
    this.latest.set(id, url);

    const current = this.pending.get(id);
    if (current) return current;

    const task = this.update(id).finally(() => {
      this.pending.delete(id);
      this.latest.delete(id);
    });
    this.pending.set(id, task);
    return task;
  }

  private async update(id: string): Promise<void> {
    for (;;) {
      const url = this.latest.get(id)!;
      const path = join(this.dir, `${id}.webp`);
      const previous = this.db.get(id);

      if (previous && avatarKey(previous) === avatarKey(url)) {
        try {
          await access(path);
          if (url === this.latest.get(id)) return;
          continue;
        } catch {
          // Restore a missing file.
        }
      }

      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Avatar download failed: HTTP ${response.status}`);
      }

      const image = Buffer.from(await response.arrayBuffer());

      if (url !== this.latest.get(id)) continue;

      const temporary = join(this.dir, `${id}.${randomUUID()}.tmp`);

      try {
        await writeFile(temporary, image);
        if (url !== this.latest.get(id)) continue;
        await rename(temporary, path);
        this.db.save(id, url);
        console.log(`[avatar] ${id} updated`);
      } finally {
        await unlink(temporary).catch(() => {});
      }

      if (url === this.latest.get(id)) return;
    }
  }
}
