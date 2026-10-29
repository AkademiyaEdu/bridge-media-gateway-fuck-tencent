import { resolve } from "node:path";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const config = {
  token: env("DISCORD_BOT_TOKEN"),
  channelId: process.env.DISCORD_CHANNEL_ID?.trim() || undefined,
  dbPath: resolve(process.env.DB_PATH || "./data/img.db"),
  avatarDir: resolve(process.env.AVATAR_DIR || "./data/avatars"),
  imageDir: resolve(process.env.IMAGE_DIR || "./data/images"),
  publicBaseUrl: env("PUBLIC_BASE_URL"),
  apiToken: env("STORAGE_API_TOKEN"),
  snowluma: {
    url: process.env.SNOWLUMA_API_URL?.trim() || "http://127.0.0.1:3000/",
    token: process.env.SNOWLUMA_API_TOKEN?.trim() || undefined,
  },
  http: {
    host: process.env.HTTP_HOST?.trim() || "127.0.0.1",
    port: Number(process.env.HTTP_PORT || "8787"),
  },
};
