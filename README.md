# Bridge Media Gateway

QQ ↔ Discord Bridge 的媒体网关：保存图片、维护 Discord 用户头像，以及为 QQ 群文件提供固定访问地址和动态 HTTP 302 重定向。

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
  "snowluma": {
    "url": "http://127.0.0.1:3000/",
    "accessToken": "SnowLuma OneBot HTTP Access Token"
  },
  "http": {
    "host": "127.0.0.1",
    "port": 8787
  }
}
```

- `discord.channelId` 留空时，监听 Bot 可见的所有服务器频道消息来更新头像。
- `storage.publicBaseUrl` 是图片和媒体链接的公网域名。
- `snowluma.url` **必须是 OneBot HTTP API**，不能填 WebSocket 地址；无需公网开放。若未设置 OneBot Token，`accessToken` 可以留空。
- `config.json` 被 Git 忽略。默认从**当前工作目录**读取，也可以仅通过 `CONFIG_PATH` 指定其它位置（方便 NixOS 服务）。
- 原有 SQLite `avatar` 表不变；`media_file` 表会自动创建。头像和文件共用一个 `MediaDatabase` 实例。

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
| POST | `/media` | 登记 QQ 群文件 | Bearer API Token |
| GET / HEAD | `/media/:id` | 刷新 FTN URL 并重定向（302） | 无 |

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
POST /media
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

新媒体 ID 是 **11 位大小写敏感 Base62**（`a-zA-Z0-9`）随机字符。数据库对 `(groupId, fileId, busId)` 去重，重复登记返回同一 ID。旧版本已经登记的 UUID 仍能正常访问，不需要迁移数据库。

公开的 `GET /media/:id` 与 `HEAD /media/:id` 会查询 SQLite，通过 SnowLuma 的 `get_group_file_url` 获取新 FTN 链接，返回：

```http
HTTP/1.1 302 Found
Location: https://tjc-download.ftn.qq.com/...
Cache-Control: no-store
```

Gateway 不下载 QQ 文件本体。不存在的 ID 返回 404，SnowLuma 刷新失败返回 502。**刷新 URL 不能延长 QQ 文件本身的有效期。** 当前只实现 `type: "file"`，原生 `video` 后续开发。

## 反向代理

图片、头像继续由 Nginx 等静态服务读取；`/media` 和 `/media/*` 必须反代到 Gateway：

```nginx
location /avatars/ {
    alias /var/lib/bridge-img-storage/avatars/;
    add_header Cache-Control "public, max-age=60, must-revalidate";
}

location /images/ {
    alias /mnt/gdrive/bridge-img-storage/images/;
    add_header Cache-Control "public, max-age=31536000, immutable";
}

location /media {
    proxy_pass http://127.0.0.1:8787;
}
```

Node 默认监听 `127.0.0.1:8787`。公网只放行需要公开的媒体访问路径；注册 API 应保持鉴权。

## Nix package

当前 Nix 可执行文件名仍保留旧名称 `bridge-img-storage`：

```bash
nix build github:AkademiyaEdu/bridge-media-gateway-fuck-tencent
./result/bin/bridge-img-storage
```

生产时将 `config.json` 放在服务 `WorkingDirectory` 中，或传 `CONFIG_PATH` 指定位置。数据文件应保存在 Nix store 外。
