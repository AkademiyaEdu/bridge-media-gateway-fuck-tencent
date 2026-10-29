import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImageStore } from "../src/store/image.js";

test("image URLs are all validated before starting any download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-gateway-images-"));
  const images = new ImageStore(dir, "https://media.example.com");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    });
  };

  try {
    assert.throws(
      () => images.save([
        "https://cdn.discordapp.com/attachments/123/image.png",
        "https://untrusted.example/image.png",
      ]),
      /Unsupported image URL/,
    );
    assert.deepEqual(requests, []);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image filenames distinguish content types and deduplicate identical files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-gateway-images-"));
  const images = new ImageStore(dir, "https://media.example.com");
  const originalFetch = globalThis.fetch;
  const source = "https://cdn.discordapp.com/attachments/123/image.png";
  let contentType = "image/png";

  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": contentType },
  });

  try {
    const [first, second] = await images.save([source, source]);
    assert.equal(first, second);
    assert.match(first, /\.png$/);
    assert.equal(readdirSync(dir).length, 1);

    contentType = "image/webp";
    const [differentType] = await images.save([source]);
    assert.match(differentType, /\.webp$/);
    assert.notEqual(differentType, first);
    assert.equal(readdirSync(dir).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
