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
const avatars = new AvatarStore(config.storage.avatarDir, db, config.discord);
const images = new ImageStore(config.storage.imageDir, config.storage.publicBaseUrl);
const files = new FileStore(
  db,
  config.storage.publicBaseUrl,
  config.snowluma.url,
  config.snowluma.accessToken,
);
const server = createStorageServer(images, files, config.storage.apiToken);

server.listen(config.http.port, config.http.host, () => {
  console.log(`[http] http://${config.http.host}:${config.http.port}`);
});

await avatars.start();

function stop(): void {
  server.close();
  avatars.stop();
  db.close();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
