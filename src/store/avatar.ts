import { randomUUID } from "node:crypto";
import { access, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, Events, GatewayIntentBits, type Message, type User } from "discord.js";
import type { MediaDatabase } from "../db.js";

export function avatarKey(url: string): string {
  const path = new URL(url).pathname;
  return path.match(/^\/avatars\/\d+\/((?:a_)?[0-9a-f]{32})\.[a-z0-9]+$/i)?.[1]
    ?? url;
}

export class AvatarStore {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  private readonly pendingAvatarSaves = new Map<string, Promise<void>>();
  private readonly latestAvatarUrls = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly db: MediaDatabase,
    private readonly discord: { token: string; channelId: string },
  ) {
    this.client.on(Events.MessageCreate, (message) => this.handleMessageCreate(message));
    this.client.on(Events.UserUpdate, (before, after) => this.handleUserUpdate(before, after));
    this.client.once(Events.ClientReady, (ready) => {
      console.log(`[discord] ${ready.user.tag}`);
    });
  }

  async start(): Promise<void> {
    await this.client.login(this.discord.token);
  }

  stop(): void {
    this.client.destroy();
  }

  private handleMessageCreate(message: Message): void {
    if (
      !message.author.bot &&
      (!this.discord.channelId || message.channelId === this.discord.channelId)
    ) {
      this.saveAvatarFromEvent(message.author);
    }
  }

  private handleUserUpdate(before: User, after: User): void {
    if (after.avatar !== before.avatar) {
      this.saveAvatarFromEvent(after);
    }
  }

  private saveAvatarFromEvent(user: Pick<User, "id" | "displayAvatarURL">): void {
    void this.save(user).catch((error) => {
      console.error(`[avatar] ${user.id}:`, error);
    });
  }

  save(user: Pick<User, "id" | "displayAvatarURL">): Promise<void> {
    const id = user.id;
    const url = user.displayAvatarURL({ extension: "webp", size: 32 });
    this.latestAvatarUrls.set(id, url);

    const current = this.pendingAvatarSaves.get(id);
    if (current) return current;

    const task = this.saveLatestAvatar(id).finally(() => {
      this.pendingAvatarSaves.delete(id);
      this.latestAvatarUrls.delete(id);
    });
    this.pendingAvatarSaves.set(id, task);
    return task;
  }

  private async saveLatestAvatar(id: string): Promise<void> {
    for (;;) {
      const url = this.latestAvatarUrls.get(id)!;
      const path = join(this.dir, `${id}.webp`);
      const previous = (this.db.avatarUrlById.get(id) as { url: string } | undefined)?.url;

      if (previous && avatarKey(previous) === avatarKey(url)) {
        try {
          await access(path);
          if (url === this.latestAvatarUrls.get(id)) return;
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

      if (url !== this.latestAvatarUrls.get(id)) continue;

      const temporary = join(this.dir, `${id}.${randomUUID()}.tmp`);

      try {
        await writeFile(temporary, image);
        if (url !== this.latestAvatarUrls.get(id)) continue;
        await rename(temporary, path);
        this.db.upsertAvatar.run(id, url);
        console.log(`[avatar] ${id} updated`);
      } finally {
        await unlink(temporary).catch(() => {});
      }

      if (url === this.latestAvatarUrls.get(id)) return;
    }
  }
}
