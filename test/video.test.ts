import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MediaDatabase } from "../src/db.js";
import { createStorageServer } from "../src/server.js";
import { ImageStore } from "../src/store/image.js";
import { MediaStore } from "../src/store/media.js";

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
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("native QQ video registration, cached redirects and shared OneBot refresh", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);

  const dir = mkdtempSync(join(tmpdir(), "bridge-video-"));
  const requests: { action: string; params: { message_id: number } }[] = [];
  const onebot = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer onebot-secret");
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { action: string; params: { message_id: number } };
    requests.push(request);

    const segments = request.params.message_id === -999
      ? [{ type: "text", data: { text: "no video" } }]
      : [
          { type: "text", data: { text: "hello" } },
          {
            type: "video",
            data: {
              url: `https://multimedia.nt.qq.com.cn/download?clip=1&rkey=${requests.length}`,
            },
          },
        ];

    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { message: segments },
      }));
    }, 50);
  });

  const onebotUrl = await listen(onebot);
  const dbPath = join(dir, "media.db");
  const db = new MediaDatabase(dbPath);
  const media = new MediaStore(db, "https://media.example.com", onebotUrl, "onebot-secret");
  const images = new ImageStore(join(dir, "images"), "https://media.example.com");
  const gateway = createStorageServer(images, media, "gateway-secret");
  const gatewayUrl = await listen(gateway);

  async function register(messageId: unknown): Promise<Response> {
    return fetch(new URL("api/media", gatewayUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer gateway-secret",
      },
      body: JSON.stringify({ type: "video", messageId }),
    });
  }

  try {
    assert.equal((await register("invalid")).status, 400);
    const messageId = -1142862561;
    const registered = await register(messageId);
    assert.equal(registered.status, 201);
    const video = (await registered.json()) as { id: string; url: string };
    assert.match(video.id, /^[a-zA-Z0-9]{11}$/);
    assert.equal(video.url, `https://media.example.com/media/${video.id}`);
    assert.equal((db.videoMessageIdById.get(video.id) as { message_id: number }).message_id, messageId);
    assert.deepEqual(await (await register(messageId)).json(), video);

    const reopened = new MediaDatabase(dbPath);
    assert.equal(
      new MediaStore(reopened, "https://media.example.com", onebotUrl).registerVideo(messageId).id,
      video.id,
    );
    reopened.close();

    const shortLink = new URL(`media/${video.id}`, gatewayUrl);
    const firstBatch = await Promise.all(
      Array.from({ length: 10 }, () => fetch(shortLink, { redirect: "manual" })),
    );
    for (const response of firstBatch) {
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"),
        "https://multimedia.nt.qq.com.cn/download?clip=1&rkey=1&filename=placeholder.mp4");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(requests, [{ action: "get_msg", params: { message_id: messageId } }]);

    const cached = await fetch(shortLink, { method: "HEAD", redirect: "manual" });
    assert.equal(cached.status, 302);
    assert.equal(cached.headers.get("location"),
      "https://multimedia.nt.qq.com.cn/download?clip=1&rkey=1&filename=placeholder.mp4");
    assert.equal(requests.length, 1);

    now += 5 * 60 * 1000;
    const refreshed = await fetch(shortLink, { redirect: "manual" });
    assert.equal(refreshed.status, 302);
    assert.equal(refreshed.headers.get("location"),
      "https://multimedia.nt.qq.com.cn/download?clip=1&rkey=2&filename=placeholder.mp4");
    assert.equal(requests.length, 2);

    const noVideo = (await (await register(-999)).json()) as { id: string };
    const failed = await fetch(new URL(`media/${noVideo.id}`, gatewayUrl), {
      redirect: "manual",
    });
    assert.equal(failed.status, 502);

    const unknown = await fetch(new URL("media/does-not-exist", gatewayUrl), {
      redirect: "manual",
    });
    assert.equal(unknown.status, 404);
  } finally {
    await close(gateway);
    await close(onebot);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("forward video URLs refresh through get_forward_msg, not get_msg", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);

  const dir = mkdtempSync(join(tmpdir(), "bridge-forward-video-"));
  const requests: { action: string; params: { id: string } }[] = [];
  const onebot = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { action: string; params: { id: string } };
    requests.push(request);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      data: {
        messages: [
          { message: [{ type: "text", data: { text: "first" } }] },
          { message: [{ type: "video", data: {
            url: `https://multimedia.nt.qq.com.cn/download?forward=1&rkey=${requests.length}`,
          } }] },
        ],
      },
    }));
  });

  const onebotUrl = await listen(onebot);
  const dbPath = join(dir, "media.db");
  const db = new MediaDatabase(dbPath);
  const media = new MediaStore(db, "https://media.example.com", onebotUrl);
  const images = new ImageStore(join(dir, "images"), "https://media.example.com");
  const gateway = createStorageServer(images, media, "gateway-secret");
  const gatewayUrl = await listen(gateway);

  const register = (nodeIndex: unknown) => fetch(new URL("api/media", gatewayUrl), {
    method: "POST",
    headers: {
      authorization: "Bearer gateway-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "forwardVideo", forwardId: "forward-123", nodeIndex }),
  });

  try {
    assert.equal((await register(-1)).status, 400);
    assert.equal((await register("1")).status, 400);
    const first = await register(1);
    assert.equal(first.status, 201);
    const video = await first.json() as { id: string; url: string };
    assert.match(video.id, /^[a-zA-Z0-9]{11}$/);
    assert.deepEqual(await (await register(1)).json(), video);
    assert.notEqual((await (await register(0)).json() as { id: string }).id, video.id);

    const reopened = new MediaDatabase(dbPath);
    assert.equal(
      new MediaStore(reopened, "https://media.example.com", onebotUrl)
        .registerForwardVideo("forward-123", 1).id,
      video.id,
    );
    reopened.close();

    const shortUrl = new URL(`media/${video.id}`, gatewayUrl);
    const firstRedirect = await fetch(shortUrl, { redirect: "manual" });
    assert.equal(firstRedirect.status, 302);
    assert.equal(firstRedirect.headers.get("location"),
      "https://multimedia.nt.qq.com.cn/download?forward=1&rkey=1&filename=placeholder.mp4");

    const cached = await fetch(shortUrl, { redirect: "manual" });
    assert.equal(cached.headers.get("location"), firstRedirect.headers.get("location"));
    assert.deepEqual(requests, [{ action: "get_forward_msg", params: { id: "forward-123" } }]);

    now += 5 * 60 * 1000;
    const refreshed = await fetch(shortUrl, { redirect: "manual" });
    assert.equal(refreshed.headers.get("location"),
      "https://multimedia.nt.qq.com.cn/download?forward=1&rkey=2&filename=placeholder.mp4");
    assert.equal(requests.length, 2);

    const missingVideo = await register(2);
    const unavailable = await fetch(new URL(
      `media/${(await missingVideo.json() as { id: string }).id}`,
      gatewayUrl,
    ), { redirect: "manual" });
    assert.equal(unavailable.status, 502);
  } finally {
    await close(gateway);
    await close(onebot);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
