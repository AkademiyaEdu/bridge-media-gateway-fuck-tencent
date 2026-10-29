import { Client, Events, GatewayIntentBits } from "discord.js";
import { mkdir } from "node:fs/promises";
import { config } from "./config.js";
import { MediaDatabase } from "./db.js";
import { AvatarStore } from "./avatar.js";
import { FileStore } from "./file.js";
import { ImageStore } from "./image.js";
import { createStorageServer } from "./server.js";

await Promise.all([
  mkdir(config.avatarDir, { recursive: true }),
  mkdir(config.imageDir, { recursive: true }),
]);

const db = new MediaDatabase(config.dbPath);
const avatars = new AvatarStore(config.avatarDir, db);
const images = new ImageStore(config.imageDir, config.publicBaseUrl);
const files = new FileStore(
  db,
  config.publicBaseUrl,
  config.snowluma.url,
  config.snowluma.token,
);
const server = createStorageServer(images, files, config.apiToken);
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
    (!config.channelId || msg.channelId === config.channelId)
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

await client.login(config.token);

function stop(): void {
  server.close();
  client.destroy();
  db.close();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
