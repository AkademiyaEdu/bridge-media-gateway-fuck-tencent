# Bridge Media Gateway

QQ ↔ Discord Bridge 的媒体网关：保存图片、维护 Discord 用户头像，以及为 QQ 群文件和原生视频提供固定访问地址和动态 HTTP 302 重定向。

## 配置与运行

使用与主 Bridge 一致的 `config.json`。复制示例后填写 Token 和域名：

```bash
nix develop
pnpm install
cp config.example.json config.json
pnpm dev
```

```json
{
  "discord": {
    "token": "Discord Bot Token",
    "channelId": ""
  },
  "db": {
    "path": "./data/img.db"
  },
  "storage": {
    "avatarDir": "./data/avatars",
    "imageDir": "./data/images",
    "publicBaseUrl": "https://media.example.com",
    "apiToken": "与主桥共享的 API Token"
  },
  "onebot": {
    "url": "http://127.0.0.1:3000/",
    "accessToken": "OneBot HTTP Access Token"
  },
  "http": {
    "host": "127.0.0.1",
    "port": 8787
  }
}
```

- `discord.channelId` 留空时，监听 Bot 可见的所有服务器频道消息来更新头像。
- `storage.publicBaseUrl` 是图片和媒体链接的公网域名。
- `onebot.url` **必须是 OneBot HTTP API**，不能填 WebSocket 地址；无需公网开放。若未设置 OneBot Token，`accessToken` 可以留空。
- `config.json` 被 Git 忽略。默认从**当前工作目录**读取，也可以仅通过 `CONFIG_PATH` 指定其它位置（方便 NixOS 服务）。
- 原有 SQLite `avatar` 表不变；`media_file` 和 `media_video` 表会自动创建。头像、群文件和原生视频共用一个 `MediaDatabase` 实例。

检查：

```bash
pnpm typecheck
pnpm test
```

## HTTP 路由

各端点在 `src/endpoint/` 下独立注册，`server.ts` 仅负责接线。

| Method | Path | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/healthz` | 健康检查（204） | 无 |
| POST | `/api/images` | 图片镜像 | Bearer API Token |
| POST | `/api/media` | 登记 QQ 群文件或原生视频 | Bearer API Token |
| GET / HEAD | `/media/:id` | 刷新 QQ 媒体 URL 并重定向（302） | 无 |

### 图片

`POST /api/images` 的 JSON Body 是 URL 数组：

```json
[
  "https://cdn.discordapp.com/attachments/123/456/image.png?...",
  "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=...&rkey=..."
]
```

仅接受腾讯 `multimedia.nt.qq.com.cn`、Discord `cdn.discordapp.com`、`media.discordapp.net` 的 HTTPS 地址。按内容 SHA-256 去重，并返回对应的 `/images/{sha256}.{ext}` 永久链接，图片本体由静态 Web 服务提供。

### QQ 群文件

Bridge 完成配对、媒体类型和大小判断后登记文件：

```http
POST /api/media
Authorization: Bearer <storage.apiToken>
Content-Type: application/json

{
  "type": "file",
  "groupId": 1107219739,
  "fileId": "原始 QQ 群文件 file_id",
  "busId": 104
}
```

`busId` 不提供时默认 `102`，有真实值时请传实际值。返回（HTTP 201）：

```json
{
  "id": "aZ7x2Bc9Q1m",
  "url": "https://media.example.com/media/aZ7x2Bc9Q1m"
}
```

原生 QQ 视频使用 OneBot 消息 ID 登记：

```http
POST /api/media
Authorization: Bearer <storage.apiToken>
Content-Type: application/json

{
  "type": "video",
  "messageId": -1142862561
}
```

`messageId` 是 OneBot 消息事件的 `message_id`（**可能为负数**），不是 QQ 官方 Bot 的消息 ID，也不是视频 URL 或文件名。重复登记同一 `messageId` 返回同一短链。网关通过 OneBot `get_msg` 读取 `message` 数组中的 `video.data.url`；若消息已无法读取或找不到有效视频 URL，返回 502。

新媒体 ID 是 **11 位大小写敏感 Base62**（`a-zA-Z0-9`）随机字符。数据库对 `(groupId, fileId, busId)` 去重，重复登记返回同一 ID。旧版本已经登记的 UUID 仍能正常访问，不需要迁移数据库。

公开的 `GET /media/:id` 与 `HEAD /media/:id` 会查询 SQLite，群文件通过 OneBot 的 `get_group_file_url` 获取 FTN 链接，原生视频通过 `get_msg` 获取新视频 URL。**每个媒体 ID 的下载 URL 在进程内缓存 5 分钟**：期间所有请求复用缓存；未命中或过期时，同一 ID 的并发请求只会触发一次 OneBot 刷新。刷新失败不会缓存，后续请求可以重试。每次访问仍然返回：

```http
HTTP/1.1 302 Found
Location: https://tjc-download.ftn.qq.com/...
Cache-Control: no-store
```

`Cache-Control: no-store` 仍然阻止客户端或 CDN 缓存 302；5 分钟缓存只存在于 Gateway 服务端，过期条目会在下一次访问时删除。

Gateway 不下载 QQ 媒体本体。不存在的 ID 返回 404，OneBot 刷新失败返回 502。**刷新 URL 不能延长 QQ 媒体本身的有效期。**

## 反向代理

图片、头像继续由 Nginx 等静态服务读取；`/media` 和 `/media/*` 必须反代到 Gateway：

```nginx
location /avatars/ {
    alias /var/lib/bridge-media-gateway/avatars/;
    add_header Cache-Control "public, max-age=60, must-revalidate";
}

location /images/ {
    alias /mnt/gdrive/bridge-media-gateway/images/;
    add_header Cache-Control "public, max-age=31536000, immutable";
}

location /media {
    proxy_pass http://127.0.0.1:8787;
}
```

Node 默认监听 `127.0.0.1:8787`。公网只放行需要公开的媒体访问路径；注册 API 应保持鉴权。

## Nix package

Nix 可执行文件名为 `bridge-media-gateway`：

```bash
nix build github:AkademiyaEdu/bridge-media-gateway-fuck-tencent
./result/bin/bridge-media-gateway
```

生产时将 `config.json` 放在服务 `WorkingDirectory` 中，或传 `CONFIG_PATH` 指定位置。数据文件应保存在 Nix store 外。
