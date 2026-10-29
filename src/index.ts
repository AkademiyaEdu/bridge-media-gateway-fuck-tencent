import { Client, Events, GatewayIntentBits } from "discord.js";
import { mkdir } from "node:fs/promises";
import { config } from "./config.js";
import { MediaDatabase } from "./db.js";
import { AvatarStore } from "./store/avatar.js";
import { FileStore } from "./store/file.js";
import { ImageStore } from "./store/image.js";
import { createStorageServer } from "./server.js";

await Promise.all([
  mkdir(config.storage.avatarDir, { recursive: true }),
  mkdir(config.storage.imageDir, { recursive: true }),
]);

const db = new MediaDatabase(config.db.path);
const avatars = new AvatarStore(config.storage.avatarDir, db);
const images = new ImageStore(config.storage.imageDir, config.storage.publicBaseUrl);
const files = new FileStore(
  db,
  config.storage.publicBaseUrl,
  config.snowluma.url,
  config.snowluma.accessToken,
);
const server = createStorageServer(images, files, config.storage.apiToken);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

function update(user: Parameters<AvatarStore["save"]>[0]): void {
  void avatars.save(user).catch((error) => {
    console.error(`[avatar] ${user.id}:`, error);
  });
}

client.on(Events.MessageCreate, (msg) => {
  if (
    !msg.author.bot &&
    (!config.discord.channelId || msg.channelId === config.discord.channelId)
  ) {
    update(msg.author);
  }
});

client.on(Events.UserUpdate, (_before, after) => {
  if (after.avatar !== _before.avatar) {
    update(after);
  }
});

client.once(Events.ClientReady, (ready) => {
  console.log(`[discord] ${ready.user.tag}`);
});

server.listen(config.http.port, config.http.host, () => {
  console.log(`[http] http://${config.http.host}:${config.http.port}`);
});

await client.login(config.discord.token);

function stop(): void {
  server.close();
  client.destroy();
  db.close();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
