# Bridge Image Storage

QQ/Discord 桥的独立图片存储进程。目前负责监听 Discord 用户头像，以及保存 Discord / QQ 两侧需要长期公网访问的图片。

Discord 和 QQ 图片共用 `IMAGE_DIR`。下载完成后按内容计算 SHA-256，并保存为 `{sha256}.{ext}`，因此两侧字节完全相同的图片只会存一份。

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

Discord 和 QQ 共用同一个目录及命名空间，因此相同内容会自动去重；并发写入同一内容也会合并到同一个最终文件。所有图片都通过 `/images/` 暴露。

`GET /healthz` 不需要鉴权。写接口使用 Bearer Token；公网部署时应由 Nginx/Caddy 提供 HTTPS，Node 继续监听 `127.0.0.1`。

## 静态文件

本进程只提供控制 API，不直接提供图片文件。由 Nginx、Caddy 或 CDN 读取数据目录：

```nginx
location /avatars/ {
    alias /var/lib/bridge-img-storage/avatars/;
    add_header Cache-Control "public, max-age=60, must-revalidate";
}

location /images/ {
    alias /mnt/gdrive/bridge-img-storage/images/;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

头像文件名是 `{userid}.webp`，会被覆盖，因此不能长期 immutable。图片 URL 由内容 SHA-256 决定，不会变化，可以长期缓存。
