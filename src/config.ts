import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface RawConfig {
  discord: {
    token: string;
    channelId: string;
  };
  db: {
    path: string;
  };
  storage: {
    avatarDir: string;
    imageDir: string;
    publicBaseUrl: string;
    apiToken: string;
  };
  snowluma: {
    url: string;
    accessToken: string;
  };
  http: {
    host: string;
    port: number;
  };
}

const configPath = process.env.CONFIG_PATH?.trim() || "./config.json";
const raw = JSON.parse(readFileSync(configPath, "utf8")) as RawConfig;

export const config = {
  ...raw,
  db: {
    path: resolve(raw.db.path),
  },
  storage: {
    ...raw.storage,
    avatarDir: resolve(raw.storage.avatarDir),
    imageDir: resolve(raw.storage.imageDir),
  },
};
