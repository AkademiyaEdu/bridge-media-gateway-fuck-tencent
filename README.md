# Bridge Media Gateway

QQ/Discord 桥的独立媒体进程。负责 Discord 头像、QQ/Discord 图片持久化，以及 QQ 群文件的动态下载重定向。

Discord 和 QQ 图片共用 `IMAGE_DIR`。下载完成后按内容计算 SHA-256，并结合响应图片类型保存为 `{sha256}.{ext}`；相同内容且类型一致的图片只会存一份。

## Nix package

Flake 同时提供生产 package 和开发环境。公开仓库可以直接构建或运行：

```bash
nix build github:AkademiyaEdu/bridge-img-storage
./result/bin/bridge-img-storage
```

也可以直接：

```bash
nix run github:AkademiyaEdu/bridge-img-storage
```

Package 使用 Node.js 26 和 pnpm 10 构建 TypeScript，产物中只保留运行时依赖，并提供 `bin/bridge-img-storage` 启动入口。程序数据仍应放在 Nix store 之外，例如 `/var/lib/bridge-img-storage`。

如果要从另一个 flake 引用：

```nix
inputs.bridge-img-storage = {
  url = "github:AkademiyaEdu/bridge-img-storage";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

对应 package 为：

```nix
inputs.bridge-img-storage.packages.${pkgs.system}.default
```

## 开发

开发环境直接使用 nixpkgs 的 Node.js 26、pnpm 10、git 和 jq。

```bash
nix develop
pnpm install
cp .env.example .env
```

配置示例：

```dotenv
DISCORD_BOT_TOKEN=你的BotToken
DISCORD_CHANNEL_ID=需要监听头像的频道ID
DB_PATH=./data/img.db
AVATAR_DIR=./data/avatars
IMAGE_DIR=./data/images
PUBLIC_BASE_URL=https://brg-img.example.com
STORAGE_API_TOKEN=与主桥共享的随机Token
SNOWLUMA_API_URL=http://127.0.0.1:3000/
SNOWLUMA_API_TOKEN=SnowLuma 的 OneBot HTTP Access Token（可选）
HTTP_HOST=127.0.0.1
HTTP_PORT=8787
```

`DISCORD_CHANNEL_ID` 留空时会监听 Bot 可见的所有服务器频道消息。`PUBLIC_BASE_URL` 是静态图片的公网域名。SQLite 默认使用 `./data/img.db`。如果使用 rclone mount / VFS，把 `IMAGE_DIR` 指向挂载目录即可；SQLite 和头像目录仍建议保留在本地磁盘。

```bash
pnpm typecheck
pnpm test
pnpm dev
```

## Image storage API

Discord 和 QQ 图片统一通过同一个接口保存：

```http
POST /api/images
Authorization: Bearer <STORAGE_API_TOKEN>
Content-Type: application/json

[
  "https://cdn.discordapp.com/attachments/123/456/image.png?...",
  "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=...&rkey=..."
]
```

请求体是图片临时 URL 数组，不需要额外传资源 ID。本进程会立即并发下载。

目前只接受 HTTPS 的两个来源域名：

- `cdn.discordapp.com`，包括 attachment、emoji 等 CDN 资源
- `multimedia.nt.qq.com.cn`

其他 URL 会被拒绝。服务不依赖具体 URL 路径格式，永久文件名始终由下载内容的 SHA-256 决定。

接口按请求顺序返回永久 URL：

```json
[
  "https://brg-img.example.com/images/3c9f...f12a.png",
  "https://brg-img.example.com/images/7d2a...91be.webp"
]
```

Discord 和 QQ 共用同一个目录及命名空间，因此相同内容且类型一致时会自动去重；并发写入同一内容也会合并到同一个最终文件。所有图片都通过 `/images/` 暴露。

`GET /healthz` 不需要鉴权。写接口使用 Bearer Token；公网部署时应由 Nginx/Caddy 提供 HTTPS，Node 继续监听 `127.0.0.1`。

## 静态文件

图片仍由 Nginx、Caddy 或 CDN 直接读取数据目录；新的动态媒体下载路由交给本进程处理：

```nginx
location /avatars/ {
    alias /var/lib/bridge-img-storage/avatars/;
    add_header Cache-Control "public, max-age=60, must-revalidate";
}

location /images/ {
    alias /mnt/gdrive/bridge-img-storage/images/;
    add_header Cache-Control "public, max-age=31536000, immutable";
}

location /media/ {
    proxy_pass http://127.0.0.1:8787;
}

location = /media {
    proxy_pass http://127.0.0.1:8787;
}
```

头像文件名是 `{userid}.webp`，会被覆盖，因此不能长期 immutable。图片 URL 由内容 SHA-256 决定，不会变化，可以长期缓存。

## QQ 群文件动态重定向

Media Gateway 只登记群文件身份，不下载或持久化文件本体。主桥完成消息配对和大小判断后，通过 Bearer Token 登记文件：

```http
POST /media
Authorization: Bearer <STORAGE_API_TOKEN>
Content-Type: application/json

{
  "type": "file",
  "groupId": 1107219739,
  "fileId": "原始 QQ 群文件 file_id",
  "busId": 104
}
```

`busId` 不提供时使用 SnowLuma 默认值 `102`；有真实 `busid` 时应传实际值。相同的 `groupId + fileId + busId` 重复登记会返回同一媒体 ID。成功返回 HTTP 201：

```json
{
  "id": "2e48cc68-9e5c-48d1-9524-080e6ee8ff54",
  "url": "https://media.example.com/media/2e48cc68-9e5c-48d1-9524-080e6ee8ff54"
}
```

Discord 消息使用返回的固定 URL。公开的 `GET /media/:id` 和 `HEAD /media/:id` 每次请求都会：

1. 根据 SQLite 中保存的群号、`file_id` 和 `busid` 查找文件；
2. 请求 SnowLuma 的 OneBot Action `get_group_file_url`；
3. 用 `302 Found` 和 `Cache-Control: no-store` 重定向到新的腾讯 FTN 下载 URL。

不存在的媒体 ID 返回 404；SnowLuma 请求或刷新失败返回 502，不会重定向到已知过期的 URL。**URL 可刷新不代表 QQ 文件本体不会过期或被删除。**

`SNOWLUMA_API_URL` 应指向 Media Gateway 能访问的 **SnowLuma OneBot HTTP 服务地址**（默认 `http://127.0.0.1:3000/`），而非 WebSocket URL；如 OneBot HTTP 开启了 Access Token，填入 `SNOWLUMA_API_TOKEN`。SnowLuma HTTP 无需向公网开放。

`POST /media` 和 `POST /api/images` 都需要 `STORAGE_API_TOKEN`，公开的下载端点不需要 Token。这个阶段只支持 `type: "file"`；原生视频刷新留待后续实现。
