<div align="center">

# 🐾 Animal Cup — AI 动物足球模拟器

**AI Animal Football Simulator**

从 8 支动物国家队中挑选你的队伍，排布阵型，观看或亲自操控 7v7 足球赛事，并通过局域网或公网与朋友对战。

Pick from 8 animal national teams, set your formation, watch or control a 7v7 match, and play with friends over LAN or the public internet.

[English](#english) · [中文](#中文)

</div>

---

<a name="中文"></a>

## 中文

> **项目来源**
> 本项目基于 [HappySeeds](https://happyseeds.ai/) 平台上的原创作品
> [Animal Cup](https://app-ce3abc4512.happyseeds.space/) Remix 后，
> 使用 **Claude Code** 进行二次开发并开源。

### 🎮 简介

Animal Cup 灵感来自经典街机足球游戏。你可以从 8 支动物国家队中选择队伍、设置阵型，观看 AI 模拟比赛，也可以使用键盘、触屏或手机手柄亲自操控。游戏支持本地单人、局域网最多 8 人手机手柄对战（每边 4 人 + AI 补位），以及两种邀请制公网联机模式。

### 🚀 技术栈

- **框架**：Next.js 15（App Router）+ React 19
- **比赛引擎**：预构建的 Pixi.js 运行时（`public/match-runtime-min/`）
- **部署**：Cloudflare Workers（通过 OpenNext）+ Durable Objects
- **多人对战**：局域网 WebSocket 中继 + 主机权威的公网房间与帧同步
- **国际化**：内置多语言支持（`app/i18n/`）

### 📂 项目结构

```text
app/
├── api/          # 后端 API 路由
├── data/         # 队伍、球员等游戏数据
├── i18n/         # 多语言文案
├── lan/          # 局域网对战页面
├── lobby/        # 大厅（选队、排阵型）
├── match/        # 比赛页面
├── online/       # 公网房间和客户端协议
├── online-pad/   # 公网手机手柄入口
├── pad/          # 手机手柄页面
├── ui/           # UI 组件
├── GameClient.jsx  # 游戏客户端入口
├── Landing.jsx     # 落地页
└── layout.jsx      # 全局布局
public/
└── match-runtime-min/   # 预构建的比赛引擎（Pixi 运行时）
cloudflare/       # Durable Object 公网房间服务
online/           # Node / Worker 共用的协议与数据校验
script/           # 构建、校验和本地中继脚本
```

### 🕹 快速开始

推荐使用 pnpm（仓库已附带 `pnpm-lock.yaml`）：

```bash
# 安装依赖
pnpm install

# 启动开发服务器（端口 13000）
pnpm dev
```

打开 `http://localhost:13000` 即可。

**局域网多人对战（最多 8 人，每边 4 人）：**

```bash
pnpm dev:lan
```

比赛在共享大屏上运行，手机扫码后作为无线手柄接入。大屏打开 `/lobby` 会自己开一个 4 位房间码，并同时给出“房间码二维码”和“APK 下载二维码”：

1. 手机扫码进入 `/pad?room=XXXX`，横屏即可看到手柄；
2. 手柄顶部显示自己占的席位（红/蓝 + 球衣号）。点一下可以换号，号码**每边唯一**、被占用的号会被拒绝，1 号门将不可选；绑定后不能互换，房主锁定阵容后也不能再改；
3. 大屏 `/lobby` 的双边 7 席面板会实时显示 14 个位置：人类席位带昵称和专属配色，空位自动由 AI 补上（每边固定 1 名 AI 门将）；
4. 红队至少坐进 1 个人后 `Start` 可用，点击后阵容锁定、大屏跳转 `/match?...&lan=ROOM`，8 路输入同时生效。

每位玩家头顶会悬浮一个标签层：球衣号 + 昵称 + 专属配色，AI 为中性灰。只有当真的有手柄接入时，大屏 HUD 上才会多出一个标签按钮（`match.ctrl.labelsHide` / `labelsShow`），点它开关这一层，偏好记忆在 `localStorage`。1v1 单人模式不会绘制。

> **改完中继代码后需要重启。** `pnpm dev:lan` 会先清 `.next` 再拉起 Next（13000）和局域网中继（13001）。如果 `.next` 里东西太多删不动，用 `pnpm dev:lan:safe`（跳过删除，并会自动清理 13000/13001 上的残留监听）。

**公网多人对战：**

```bash
pnpm dev:online
```

公网模式共用一套主机权威房间系统：

- **直接操控对战**：房主和对手分别在自己的浏览器中使用键盘或触屏操作。
- **在线手机手柄对战**：两边各使用一块比赛屏幕，并用各自手机扫码作为 P1 / P2 手柄。

创建者浏览器运行唯一的比赛模拟，对手屏幕接收约 30 FPS 的二进制比赛帧；公网服务只负责房间、鉴权、输入和帧中继。房间使用 6 位邀请码，并为房主、对手屏幕和 P1/P2 手柄分别保存恢复令牌。

本地开发时，Next.js 运行在 `13000`，公网房间中继运行在 `13002`。生产环境使用 Cloudflare Durable Objects，部署顺序如下：

```bash
# 1. 将 wrangler-online.toml 的 ALLOWED_ORIGINS 改为正式网页域名
# 2. 部署公网房间 Worker
pnpm deploy:online

# 3. 将返回的 Worker 地址写入 .env.local
cp .env.example .env.local
# NEXT_PUBLIC_ONLINE_SERVICE_URL=https://<your-worker>.workers.dev

# 4. 重新构建并部署网页
pnpm build
```

公网房间是邀请制休闲对战，目前不包含账号、自动匹配、排行榜或服务端防作弊。

### 🛠 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动开发服务器（端口 13000） |
| `pnpm dev:lan` | 启动带局域网对战的开发服务器 |
| `pnpm lan` | 单独启动局域网中继服务 |
| `pnpm dev:online` | 启动网页和本地公网房间中继 |
| `pnpm online` | 单独启动本地公网房间中继 |
| `pnpm test:online` | 验证公网房间、输入和帧转发协议 |
| `pnpm test:online:browser` | 使用 Chrome 验证双屏、触控、手柄和画布渲染 |
| `pnpm test:lan` | 局域网 4v4 主链路回归（席位协议 + 席位通道 + 头顶标签 + 大厅面板） |
| `pnpm test:lan:all` | 上表全部局域网套件 + 8 手柄全流程 E2E |
| `pnpm test:lan:seats` | 只跑中继席位协议（不启浏览器） |
| `pnpm test:lan:pad` | 只跑“扫码 → 绑座 → 驱动球员”链路 |
| `pnpm test:lan:labels` | 只跑头顶标签层（号码/昵称/配色/抬升高度） |
| `pnpm test:lan:lobby` | 只跑大厅双边面板 + 手机选号 |
| `pnpm test:lan:e2e` | 只跑 8 手柄并发全流程彩排（大厅 → 开球 → 8 人同时控球） |
| `pnpm test:pads` | 验证单个手机手柄驱动引擎的底层假设 |
| `pnpm diag:lan:seats` | 诊断用：8 个假手柄静坐不动，打印用户/队伍/占位台账和第一条引擎报错栈 |
| `pnpm inspect:match <模块名>` | 把预构建引擎包按模块打印出来（支持 `--grep`），用于溯源引擎行为 |
| `pnpm deploy:online` | 部署 Cloudflare Durable Object 房间服务 |
| `pnpm build` | 生产构建 |
| `pnpm build:worker` | 构建 Cloudflare Workers 版本 |
| `pnpm start` | 运行生产构建 |

> 浏览器类套件（`test:lan:pad` / `labels` / `lobby` / `e2e`）需要本机装有 Chrome，并以**有头**模式运行——无头 SwiftShader 会把引擎渲染循环卡死。测试会自己起独立端口的中继，不会碰到 13001 上正在跑的服务。
>
> 另外：跑在这类测试期间**不要同时改 `app/**`**，Next 的 HMR 会让页面在测试中途重载，导致 `Execution context was destroyed`。改 `docs/`、`script/`、`.scratch/` 是安全的。

### 🔍 阅读预构建引擎

`public/match-runtime-min/scripts/match.rebuilt.js` 是一个 811 KB 的单行文件，里面是 142 个 AMD 模块（`define("name", fn)`），并且**没有 sourcemap、上游源码已丢失**。要查引擎行为时直接读它：

```bash
# 列出所有模块名
pnpm inspect:match --list

# 打印某个模块的完整源码（模块名用斜杠，如 pitch / core/states / players/states）
pnpm inspect:match pitch

# 全库检索某个符号出现在哪些模块里
pnpm inspect:match --grep allPlayersReady
```

自己的胶水代码都写在 `public/match-runtime-min/standalone-match.js` 里（该项目自有、可读、带注释），它是在引擎之后加载的普通脚本，改完**硬刷新**即可生效，无需重新构建。

### 📄 许可证

本项目基于 [Apache License 2.0](./LICENSE) 开源。

---

<a name="english"></a>

## English

> **Origin**
> This project is derived from the original
> [Animal Cup](https://app-ce3abc4512.happyseeds.space/) on
> [HappySeeds](https://happyseeds.ai/), remixed and rebuilt with **Claude Code**.

### 🎮 Overview

Animal Cup is inspired by classic arcade football games. Pick from 8 animal
national teams, set your formation, watch an AI-simulated 7v7 match, or take
control with a keyboard, touchscreen, or phone gamepad. It supports local
single-player, LAN phone-controller matches for up to 8 players (4 per side with
AI filling the rest), and two invite-only public online modes.

### 🚀 Tech Stack

- **Framework**: Next.js 15 (App Router) + React 19
- **Match Engine**: Pre-built Pixi.js runtime (`public/match-runtime-min/`)
- **Deployment**: Cloudflare Workers (via OpenNext) + Durable Objects
- **Multiplayer**: LAN WebSocket relay + host-authoritative public rooms and frame sync
- **i18n**: Built-in multi-language support (`app/i18n/`)

### 📂 Project Structure

```text
app/
├── api/          # Backend API routes
├── data/         # Game data (teams, players, etc.)
├── i18n/         # Localized strings
├── lan/          # LAN multiplayer pages
├── lobby/        # Lobby (team select, formation setup)
├── match/        # Match page
├── online/       # Public room UI and client protocol
├── online-pad/   # Public phone-controller entry
├── pad/          # Phone gamepad page
├── ui/           # UI components
├── GameClient.jsx  # Game client entry
├── Landing.jsx     # Landing page
└── layout.jsx      # Global layout
public/
└── match-runtime-min/   # Pre-built match engine (Pixi runtime)
cloudflare/       # Durable Object public-room service
online/           # Protocol and validation shared by Node and Workers
script/           # Build, verification, and local relay scripts
```

### 🕹 Quick Start

pnpm is recommended (a `pnpm-lock.yaml` is shipped):

```bash
# Install dependencies
pnpm install

# Start the dev server (port 13000)
pnpm dev
```

Open `http://localhost:13000`.

**LAN multiplayer (up to 8 players, 4 per side):**

```bash
pnpm dev:lan
```

The match runs on a shared big screen; phones scan a QR code to join as
wireless gamepads. Opening `/lobby` on the big screen mints its own
four-character room code and shows two QR codes — one for the room, one for the
Android gamepad APK:

1. A phone scans into `/pad?room=XXXX`; rotating to landscape reveals the pad.
2. The badge at the top of the pad shows the seat you hold (red/blue + shirt
   number). Tap it to pick a different number — numbers are unique **per side**,
   taken numbers are refused, and the #1 goalkeeper is not selectable. A seat
   cannot be swapped once bound, and the host locking the line-up freezes it.
3. The two-sided 7-seat board in `/lobby` shows all 14 slots live: human seats
   carry a nickname and their own colour, and empty slots are filled by AI
   (each side always keeps exactly one AI goalkeeper).
4. `Start` unlocks once red has at least one human. Pressing it locks the
   line-up, navigates the big screen to `/match?...&lan=ROOM`, and all eight
   input streams go live at once.

Every player gets a floating label above their head: shirt number + nickname +
personal colour (neutral grey for AI). Once pads are actually connected, the big
screen's HUD grows one extra tag button (`match.ctrl.labelsHide` /
`labelsShow`) that toggles the layer, with the preference remembered in
`localStorage`. Solo 1v1 never draws it.

> **Restart after relay changes.** `pnpm dev:lan` clears `.next` and then starts
> Next (13000) plus the LAN relay (13001). If `.next` is too large to delete,
> use `pnpm dev:lan:safe` (skips the delete and reaps stale listeners on
> 13000/13001).

**Public online multiplayer:**

```bash
pnpm dev:online
```

Both public modes share one host-authoritative room service:

- **Direct controls**: the host and guest use keyboard or touch controls in their own browsers.
- **Online phone controllers**: each side has a match screen and pairs a phone as its P1 / P2 controller.

The creator's browser runs the only match simulation. The opponent screen
receives binary match frames at about 30 FPS, while the public service only
relays room state, authenticated input, and frames. Six-character room codes
are backed by separate recovery tokens for the host, opponent screen, and P1/P2
controllers.

Local development uses ports `13000` and `13002`. For production:

1. Set `ALLOWED_ORIGINS` in `wrangler-online.toml` to the deployed web origin.
2. Run `pnpm deploy:online` to deploy the Durable Object room service.
3. Put the returned Worker URL in `.env.local` as `NEXT_PUBLIC_ONLINE_SERVICE_URL`.
4. Run `pnpm build`, then deploy the web application.

Public rooms are intended for invite-only casual play. Accounts, automatic
matchmaking, rankings, and server-side anti-cheat are not included.

### 🛠 Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the dev server (port 13000) |
| `pnpm dev:lan` | Dev server with LAN multiplayer |
| `pnpm lan` | Start the LAN relay server standalone |
| `pnpm dev:online` | Dev server with public online rooms |
| `pnpm online` | Start the local public-room relay |
| `pnpm test:online` | Verify room, input, and frame relay behavior |
| `pnpm test:online:browser` | Verify dual screens, touch, controllers, and canvas rendering in Chrome |
| `pnpm test:lan` | LAN 4v4 main-path regression (seat protocol + seat path + head labels + lobby board) |
| `pnpm test:lan:all` | Every LAN suite above, plus the 8-pad full-flow E2E |
| `pnpm test:lan:seats` | Relay seat protocol only (no browser) |
| `pnpm test:lan:pad` | Scan → bind → drive-a-player path only |
| `pnpm test:lan:labels` | Head-label layer only (number / nickname / colour / lift) |
| `pnpm test:lan:lobby` | Lobby two-side board + phone number picker only |
| `pnpm test:lan:e2e` | 8-pad concurrent dress rehearsal (lobby → kick-off → 8 pilots at once) |
| `pnpm test:pads` | Verify the low-level assumptions behind driving the engine from a pad |
| `pnpm diag:lan:seats` | Diagnostic: 8 idle fake pads, then dump the user/team/claim ledger and the first engine error stack |
| `pnpm inspect:match <module>` | Print modules out of the pre-built engine bundle (`--list`, `--grep`) |
| `pnpm deploy:online` | Deploy the Durable Object room service |
| `pnpm build` | Production build |
| `pnpm build:worker` | Build for Cloudflare Workers |
| `pnpm start` | Run the production build |

> The browser suites (`test:lan:pad` / `labels` / `lobby` / `e2e`) need Chrome
> installed and run **headed** — headless SwiftShader deadlocks the engine
> render loop. Each suite starts its own relay on a scratch port and never
> touches a running 13001.
>
> Also: **do not edit `app/**` while one of these suites is running.** Next HMR
> reloads the page under test and Playwright drops the frame with
> `Execution context was destroyed`. `docs/`, `script/`, and `.scratch/` are
> safe to edit.

### 🔍 Reading the pre-built engine

`public/match-runtime-min/scripts/match.rebuilt.js` is a single-line 811 KB file
holding 142 AMD modules (`define("name", fn)`), with **no source map and the
upstream source lost**. When you need to know what the engine actually does,
read the bundle:

```bash
# List every module name
pnpm inspect:match --list

# Print one module (names use slashes: pitch, core/states, players/states)
pnpm inspect:match pitch

# Find which modules mention a symbol
pnpm inspect:match --grep allPlayersReady
```

Our own glue lives in `public/match-runtime-min/standalone-match.js` (owned,
readable, commented). It is a plain script loaded after the engine, so a hard
refresh picks up changes — no rebuild needed.

### 📄 License

Released under the [Apache License 2.0](./LICENSE).
