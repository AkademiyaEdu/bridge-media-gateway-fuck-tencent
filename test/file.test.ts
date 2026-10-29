import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MediaDatabase, generateMediaId } from "../src/db.js";
import { DatabaseSync } from "node:sqlite";
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
  const db = new MediaDatabase(dbPath);
  const files = new FileStore(db, "https://media.example.com", snowlumaUrl, "snowluma-secret");
  db.saveAvatarUrl("123", "https://cdn.discordapp.com/avatars/123/test.webp");
  assert.equal(db.getAvatarUrl("123"), "https://cdn.discordapp.com/avatars/123/test.webp");
  const images = new ImageStore(join(dir, "images"), "https://media.example.com");
  const gateway = createStorageServer(images, files, "gateway-secret");
  const gatewayUrl = await listen(gateway);

  async function register(body: unknown, authorized = true): Promise<Response> {
    return fetch(new URL("api/media", gatewayUrl), {
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
    assert.match(stored.id, /^[a-zA-Z0-9]{11}$/);
    assert.equal(stored.url, `https://media.example.com/media/${stored.id}`);
    assert.equal(db.getFile(stored.id)?.fileId, file.fileId);

    const reopened = new MediaDatabase(dbPath);
    assert.equal(reopened.registerFile(file), stored.id);
    reopened.close();

    const second = (await (await register(file)).json()) as { id: string; url: string };
    assert.deepEqual(second, stored);

    const differentBus = (await (await register({ ...file, busId: 102 })).json()) as {
      id: string;
    };
    assert.notEqual(differentBus.id, stored.id);
    assert.match(differentBus.id, /^[a-zA-Z0-9]{11}$/);

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

    // Files registered by the previous UUID implementation keep working.
    const oldId = "2e48cc68-9e5c-48d1-9524-080e6ee8ff54";
    const connection = new DatabaseSync(dbPath);
    connection.prepare("INSERT INTO media_file (id, group_id, file_id, bus_id) VALUES (?, ?, ?, ?)")
      .run(oldId, 1107219739, "legacy-file", 102);
    connection.close();
    const oldRedirect = await fetch(new URL(`media/${oldId}`, gatewayUrl), {
      redirect: "manual",
    });
    assert.equal(oldRedirect.status, 302);

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
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("11-character Base62 IDs are well-formed and non-repeating in a sample", () => {
  const ids = Array.from({ length: 2000 }, generateMediaId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[a-zA-Z0-9]{11}$/);
  }
});
