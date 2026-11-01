import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MediaDatabase } from "../src/db.js";
import { MediaStore, generateMediaId } from "../src/store/media.js";
import { ImageStore } from "../src/store/image.js";
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

test("file registration, cached OneBot URL and redirect", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const dir = mkdtempSync(join(tmpdir(), "bridge-media-gateway-"));
  const requests: unknown[] = [];
  const onebot = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer onebot-secret");
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
          data: { url: `https://tjc-download.ftn.qq.com/file?refresh=${requests.length}&fname=%2Ftest-file` },
        }),
      );
    }
  });

  const onebotUrl = await listen(onebot);
  const dbPath = join(dir, "test.db");
  const db = new MediaDatabase(dbPath);
  const files = new MediaStore(db, "https://media.example.com", onebotUrl, "onebot-secret");
  db.upsertAvatar.run("123", "https://cdn.discordapp.com/avatars/123/test.webp");
  assert.equal((db.avatarUrlById.get("123") as { url: string }).url, "https://cdn.discordapp.com/avatars/123/test.webp");
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
    const file = { type: "file", groupId: 1107219739, fileId: "test-file", busId: 104, fileName: "2025-10-05_08-19-18.mp4" };
    assert.equal((await register(file, false)).status, 401);
    assert.equal((await register({ type: "video", messageId: "invalid" })).status, 400);

    const first = await register(file);
    assert.equal(first.status, 201);
    const stored = (await first.json()) as { id: string; url: string };
    assert.match(stored.id, /^[a-zA-Z0-9]{11}$/);
    assert.equal(stored.url, `https://media.example.com/media/${stored.id}`);
    assert.equal((db.fileById.get(stored.id) as { file_id: string }).file_id, file.fileId);
    assert.equal((db.fileById.get(stored.id) as { file_name: string }).file_name, file.fileName);

    const reopened = new MediaDatabase(dbPath);
    assert.equal(new MediaStore(reopened, "https://media.example.com", onebotUrl).registerFile(file).id, stored.id);
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
    assert.equal(redirect.headers.get("location"), "https://tjc-download.ftn.qq.com/file?refresh=1&fname=2025-10-05_08-19-18.mp4");
    assert.equal(redirect.headers.get("cache-control"), "no-store");

    const head = await fetch(new URL(`media/${stored.id}`, gatewayUrl), {
      method: "HEAD",
      redirect: "manual",
    });
    assert.equal(head.status, 302);
    assert.equal(head.headers.get("location"), "https://tjc-download.ftn.qq.com/file?refresh=1&fname=2025-10-05_08-19-18.mp4");
    assert.equal(requests.length, 1);

    now += 5 * 60 * 1000 - 1;
    const beforeExpiry = await fetch(new URL(`media/${stored.id}`, gatewayUrl), {
      redirect: "manual",
    });
    assert.equal(beforeExpiry.headers.get("location"), "https://tjc-download.ftn.qq.com/file?refresh=1&fname=2025-10-05_08-19-18.mp4");
    assert.equal(requests.length, 1);

    now++;
    const refreshed = await fetch(new URL(`media/${stored.id}`, gatewayUrl), {
      redirect: "manual",
    });
    assert.equal(refreshed.status, 302);
    assert.equal(refreshed.headers.get("location"), "https://tjc-download.ftn.qq.com/file?refresh=2&fname=2025-10-05_08-19-18.mp4");
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

    // Re-registering a file updates its name and invalidates the cached redirect.
    const corrected = { ...file, fileName: "corrected video.mp4" };
    assert.deepEqual(await (await register(corrected)).json(), stored);
    assert.equal((db.fileById.get(stored.id) as { file_name: string }).file_name, corrected.fileName);
    const correctedRedirect = await fetch(new URL(`media/${stored.id}`, gatewayUrl), {
      redirect: "manual",
    });
    assert.equal(
      correctedRedirect.headers.get("location"),
      "https://tjc-download.ftn.qq.com/file?refresh=3&fname=corrected+video.mp4",
    );

    // Files registered by the previous UUID implementation keep working.
    const oldId = "2e48cc68-9e5c-48d1-9524-080e6ee8ff54";
    db.insertFile.run(oldId, 1107219739, "legacy-file", 102, null);
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
    await close(onebot);
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

test("concurrent refreshes share one OneBot request and failures are not cached", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-media-cache-"));
  const db = new MediaDatabase(join(dir, "test.db"));
  const files = new MediaStore(db, "https://media.example.com", "http://onebot.test");
  const id = files.registerFile({ groupId: 1107219739, fileId: "test-file", busId: 104 }).id;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);

  let resolveResponse: (response: Response) => void = () => {};
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests++;
    return new Promise<Response>((resolve) => { resolveResponse = resolve; });
  });

  const respond = (result: object): void => {
    resolveResponse(new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    }));
  };
  const success = (url: string) => ({
    status: "ok",
    data: { url },
  });

  try {
    const concurrent = Array.from({ length: 10 }, () => files.getDownloadUrl(id));
    assert.equal(requests, 1);
    respond(success("https://tjc-download.ftn.qq.com/first"));
    assert.deepEqual(await Promise.all(concurrent), Array(10).fill("https://tjc-download.ftn.qq.com/first"));

    assert.equal(await files.getDownloadUrl(id), "https://tjc-download.ftn.qq.com/first");
    assert.equal(requests, 1);

    now += 5 * 60 * 1000;
    const first = files.getDownloadUrl(id);
    const second = files.getDownloadUrl(id);
    assert.equal(requests, 2);

    const failed = Promise.all([
      assert.rejects(first, /OneBot get_group_file_url failed/),
      assert.rejects(second, /OneBot get_group_file_url failed/),
    ]);
    respond({ status: "failed", retcode: 100 });
    await failed;

    const retry = files.getDownloadUrl(id);
    assert.equal(requests, 3);
    respond(success("https://tjc-download.ftn.qq.com/second"));
    assert.equal(await retry, "https://tjc-download.ftn.qq.com/second");
    assert.equal(requests, 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing media_file schema automatically gains file_name", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-media-migration-"));
  const path = join(dir, "legacy.db");
  const oldDatabase = new DatabaseSync(path);
  oldDatabase.exec(`
    CREATE TABLE media_file (
      id TEXT PRIMARY KEY,
      group_id INTEGER NOT NULL,
      file_id TEXT NOT NULL,
      bus_id INTEGER NOT NULL,
      UNIQUE (group_id, file_id, bus_id)
    ) STRICT;
    INSERT INTO media_file (id, group_id, file_id, bus_id)
      VALUES ('old-id', 123, '/old-file', 102);
  `);
  oldDatabase.close();

  const db = new MediaDatabase(path);
  try {
    assert.equal((db.fileById.get("old-id") as { file_name: string | null }).file_name, null);
    const media = new MediaStore(db, "https://media.example.com", "http://onebot.test");
    const registered = media.registerFile({
      groupId: 123,
      fileId: "/old-file",
      busId: 102,
      fileName: "restored.mp4",
    });
    assert.equal(registered.id, "old-id");
    assert.equal((db.fileById.get("old-id") as { file_name: string }).file_name, "restored.mp4");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
