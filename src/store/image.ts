import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const EXTENSION_BY_CONTENT_TYPE = new Map([
  ["image/png", "png"],
  ["image/apng", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/bmp", "bmp"],
]);

export class ImageStore {
  constructor(
    private readonly dir: string,
    private readonly publicBaseUrl: string,
  ) {}

  save(urls: readonly string[]): Promise<string[]> {
    const sources = urls.map((url) => this.validateSource(url));
    return Promise.all(sources.map((source) => this.store(source)));
  }

  private validateSource(url: string): URL {
    const source = new URL(url);

    if (
      source.protocol === "https:" &&
      (source.hostname === "cdn.discordapp.com" ||
        source.hostname === "multimedia.nt.qq.com.cn" ||
        source.hostname === "media.discordapp.net")
    ) {
      return source;
    }

    throw new Error("Unsupported image URL");
  }

  private async store(source: URL): Promise<string> {
    const response = await fetch(source, {
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`Image download failed: HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Image response is empty");
    }

    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const extension = contentType
      ? EXTENSION_BY_CONTENT_TYPE.get(contentType)
      : undefined;

    if (!extension) {
      throw new Error(`Unsupported image type: ${contentType ?? "unknown"}`);
    }

    const temporary = join(this.dir, `${randomUUID()}.tmp`);
    const hash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as any),
        hasher,
        createWriteStream(temporary, { flags: "wx" }),
      );

      const filename = `${hash.digest("hex")}.${extension}`;
      const path = join(this.dir, filename);
      try {
        await access(path);
      } catch {
        await rename(temporary, path);
      }

      console.log(`[image] ${filename}`);
      return new URL(`/images/${filename}`, this.publicBaseUrl).toString();
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
