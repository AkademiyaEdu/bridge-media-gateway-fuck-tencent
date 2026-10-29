import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileStore } from "../src/file.js";
import { ImageStore } from "../src/image.js";
import { createStorageServer } from "../src/server.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("file registration, on-demand SnowLuma refresh and redirect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-media-gateway-"));
  const requests: unknown[] = [];
  const snowluma = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer snowluma-secret");
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body) as {
      action: string;
      params: Record<string, unknown>;
    };
    requests.push(message);

    res.setHeader("content-type", "application/json");
    if (message.params.file_id === "missing-on-qq") {
      res.end(JSON.stringify({ status: "failed", retcode: 100, wording: "expired" }));
    } else {
      res.end(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { url: `https://tjc-download.ftn.qq.com/file?refresh=${requests.length}` },
        }),
      );
    }
  });

  const snowlumaUrl = await listen(snowluma);
  const dbPath = join(dir, "test.db");
  const files = new FileStore(dbPath, "https://media.example.com", snowlumaUrl, "snowluma-secret");
  const images = new ImageStore(join(dir, "images"), "https://media.example.com");
  const gateway = createStorageServer(images, files, "gateway-secret");
  const gatewayUrl = await listen(gateway);

  async function register(body: unknown, authorized = true): Promise<Response> {
    return fetch(new URL("media", gatewayUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: "Bearer gateway-secret" } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  try {
    const file = { type: "file", groupId: 1107219739, fileId: "test-file", busId: 104 };
    assert.equal((await register(file, false)).status, 401);
    assert.equal((await register({ type: "video", messageId: 1 })).status, 400);

    const first = await register(file);
    assert.equal(first.status, 201);
    const stored = (await first.json()) as { id: string; url: string };
    assert.equal(stored.url, `https://media.example.com/media/${stored.id}`);

    const second = (await (await register(file)).json()) as { id: string; url: string };
    assert.deepEqual(second, stored);

    const differentBus = (await (await register({ ...file, busId: 102 })).json()) as {
      id: string;
    };
    assert.notEqual(differentBus.id, stored.id);

    const redirect = await fetch(new URL(`media/${stored.id}`, gatewayUrl), {
      redirect: "manual",
    });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "https://tjc-download.ftn.qq.com/file?refresh=1");
    assert.equal(redirect.headers.get("cache-control"), "no-store");

    const head = await fetch(new URL(`media/${stored.id}`, gatewayUrl), {
      method: "HEAD",
      redirect: "manual",
    });
    assert.equal(head.status, 302);
    assert.equal(head.headers.get("location"), "https://tjc-download.ftn.qq.com/file?refresh=2");

    assert.deepEqual(requests, [
      {
        action: "get_group_file_url",
        params: { group_id: 1107219739, file_id: "test-file", busid: 104 },
      },
      {
        action: "get_group_file_url",
        params: { group_id: 1107219739, file_id: "test-file", busid: 104 },
      },
    ]);

    const unknown = await fetch(new URL("media/00000000-0000-0000-0000-000000000000", gatewayUrl), {
      redirect: "manual",
    });
    assert.equal(unknown.status, 404);

    const failed = (await (await register({
      type: "file",
      groupId: 1107219739,
      fileId: "missing-on-qq",
    })).json()) as { id: string };
    const unavailable = await fetch(new URL(`media/${failed.id}`, gatewayUrl), {
      redirect: "manual",
    });
    assert.equal(unavailable.status, 502);
  } finally {
    await close(gateway);
    await close(snowluma);
    files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
