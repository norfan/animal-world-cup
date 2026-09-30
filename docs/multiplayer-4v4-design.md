# 局域网 4v4 多人对战 · AI 补位 · 球员绑定 —— 设计方案

> 目标：从"1 对 1（每边 1 个真人）"扩展到**每边最多 4 个真人、单边总人数上限 7 人、空缺全部由 AI 补足**，  
> 并且**只有 1 个守门员且必须是 AI**、**手机扫码后绑定到一名固定球员且不可更换**、  
> **每名球员头顶悬浮号码、真人用不同颜色区分**。
>
> 本文给出：可行性判定 → 现状证据 → 详细设计 → 分阶段实施方案 → 风险。

---

## 0. 结论速览

| #  | 你的需求               | 引擎现状                                                         | 可行性         | 需要改动                      |
| -- | ------------------ | ------------------------------------------------------------ | ----------- | ------------------------- |
| R1 | 每边最多 4 个真人，共 8 人   | 底层 `users` 是通用多用户模型，但默认只实例化 5 个                              | ✅ 可行        | 中继席位 + 自建 3 个 user        |
| R2 | 每边总数上限 7 人         | **引擎本来就是每队 7 人（1 门将 + 6 外场）**                                | ✅ 已是现状      | 零                         |
| R3 | 空缺由 AI 补足，AI 自动算数量 | 未被 user 接管的球员天然跑 AI 状态机                                      | ✅ 可行        | 适配层按人数组装阵容                |
| R4 | 只有 1 个 AI 守门员      | **每队恰好 1 个门将；且引擎所有"找控球人"逻辑都显式排除门将**                          | ✅ 已是现状      | 只把门将席位标为"不可绑定"            |
| R5 | 绑定球员、不可更换          | `User.takeControl/attachControl` 可绑定；但有 4 处"自动抢控"会抢走         | ✅ 可行（需处理抢控） | **运行时猴子补丁** + 每帧重申（不改压缩包） |
| R6 | 头顶悬浮号码 / 真人配色      | `signs` 模块是**纯空壳**（所有方法都是空函数）；`USER_COLORS` 只有 5 色且本地模式根本不走它 | ✅ 可行        | 自建覆盖层（新代码）                |

**进度**：P0 ✅ ｜ P1 ✅ 57/57 ｜ P2 ✅ 47/47 ｜ P3 ✅ 63/63 ｜ P4 ✅ 61/61 ｜ P5 ✅ 37/37

**总评：可行。** 最大的好消息是 R2/R4 引擎已经原生满足（7v7 + 唯一门将 + 门将永不由真人控制），  
省掉了改造阵容规模与门将逻辑的工程量。真正要做的只有三件事：**席位/协议扩容**、**固定绑定 + 防抢控**、**自建头顶标签层**。

---

## 1. 引擎事实（都从打包产物里读出来，不是猜的）

> 读法：`pnpm inspect:match <模块名>`（`script/inspect-match-module.mjs`）把单行 811 KB 的
> `public/match-runtime-min/scripts/match.rebuilt.js` 按 `define("name", fn)` 拆开，
> 模块名就是字面量，所以可以直接当源码读。

| 事实                                                                    | 出处                                                  | 对设计的影响                                    |
| --------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| 每队 7 人：红 `id 0..6`，蓝 `id 7..13`                                       | `SQUAD = 7`；`data/teams/*/team.json` 里 `players.0..10` | 单边上限天然是 7（需求 R2 零成本）                      |
| 门将固定红 `id 0` / 蓝 `id 7`，皮肤 `<team>1goalkeeper`                        | `players/global` 显式排除门将找球逻辑                         | 门将席位直接标"不可绑定"（R4）                         |
| **球衣号码 = 皮肤名里的数字**：红 `id+1`，蓝 `id-7+1`                                | 运行时读 `renderer.spine.skinName`（`argentina7home` 等）  | 标签号码与球衣号码同源，必须用同一函数（见 §2.1）               |
| `users` 默认只实例化 5 个                                                     | `main`/`game` 初始化                                    | 要自造 3 个 user 才能坐满 8 人                     |
| `signs` 模块是空壳，所有方法都是空函数                                                | `require("signs")`                                   | 头顶标签**必须自建**，没有可复用的            |
| `USER_COLORS` 只有 5 色，且本地模式根本不走它                                        | `settings` + `renderers/control_indicator`           | 真人配色由中继发（`PAD_COLORS`），不指望引擎           |
| **球员精灵是 256×256 的 RenderTexture 页**                                    | `renderers/player` 构造 + `renderToTexture()`          | `sprite.getLocalBounds()` 量到的是整页，**不是角色高度**（见 §2.4） |
| `settings("PLAYER_HEIGHT") * PIXELS_Z ≈ 68` 是**停球高度**，不是身高              | `settings`；`PLAYER_HEIGHT` 用于球的 z 上限                 | 用它当"身高"会把标签抬到胸口                            |
| 引擎自己的"头顶锚点"是 `sprite.position.y - 100`                                 | `overheadIndicator.position.y`、调试 `stateLabel`      | 这是引擎对"头顶"的定义，可作对照                         |
| 渲染层级：`bottomLayer → dirt → teamSpots → indicatorLayer → shadows → middleLayer → grass → sortables → topLayer` | `renderers/stadium` 构造                              | 标签必须挂 `topLayer`（最后绘制，永不被遮挡）               |
| 投影 `worldToScreenFlat`：`x` 受 `y` 影响（透视剪切）                               | `renderers/generic`                                 | 不能用"只抬 y"的检查，必须独立重投影                       |
| `User.takeControl` 在目标已被占用时**抛异常**                                     | `Cannot take control, player already controlled`     | 守卫必须**两侧**都挡，否则每帧刷错（见 §2.3）               |

---

## 2. 设计要点

### 2.1 席位与号码

* 每边最多 `HUMANS_PER_SIDE = 4` 个真人；号码 `#2..#7` 可绑定，`#1` 永久 AI（`BINDABLE = [2,3,4,5,6,7]`）。
* 号码 ↔ 引擎 playerId 是一对互逆映射，两侧必须用同一份定义：

  ```js
  // script/lan-server.mjs —— 权威定义
  playerIdFor(side, number) = side === "blue" ? SQUAD + number - 1 : number - 1
  // public/match-runtime-min/standalone-match.js —— 标签层的逆映射
  acNumberFor(side, playerId) = (side === "blue" ? playerId - SQUAD : playerId) + 1
  ```

* 手机第一次加入时拿"本边最小空闲号"；掉线时中继**保留席位**（`SEAT_HOLD_MS`），手机靠
  `localStorage` 里的 `ac_pad_client_<room>` 稳定 id 回来复占**同一个号**——这就是"绑定不可更换"能扛住 wifi 抖动的实现。

### 2.2 协议（中继 ↔ 手机）

| 消息                     | 方向        | 说明                                                |
| ---------------------- | --------- | ------------------------------------------------- |
| `join{room,name,clientId}` | 手机 → 中继  | 带稳定 `clientId`，复占旧席位                             |
| `joined{side,number,playerId,color}` | 中继 → 手机 | 座位确认                                              |
| `bind{...}`            | 中继 → 手机  | 号码变更（主动 pick 或主机改号）                               |
| `occupancy{locked,red,blue,bindable,gkNumber,me}` | 中继 → 每台手机 | **号码占用表**：选号面板据此灰掉不可选号；`me` 让手机渲染自己的席位徽章 |
| `pick{number}`         | 手机 → 中继  | 自己选号；失败回 `pickErr{locked｜bad-number｜taken}`      |
| `lock{locked}`         | 主机 → 中继  | 开球锁号；中继广播 `locked` 给所有手机                          |
| `roster{pads,counts,locked}` | 中继 → **仅主机** | 大厅席面板的唯一数据源（手机收不到，这是刻意的）                    |

**关键决定：手机选号不换号。** 目标号被占就直接 `taken`，中继**不会**让两个人对调——
手机上永远不可能"抢走"队友身上的号码。

### 2.3 固定绑定与 P-1 守卫（必须两侧）

引擎有 4 处"自动抢控"会把球员从它的 user 手里抢走，而 `User.prototype.takeControl` 在
目标 `player.user` 已存在时**直接抛异常**，并且这个调用发生在 rAF 帧里——一旦漏挡就是**每帧刷屏报错**。

因此守卫必须同时挡两边：

```js
proto.takeControl = function (player, state, globalOverride) {
  if (this.locked && player !== this.lockedPlayer) return;              // ① 被锁的人不许自己走
  if (player && player.user && player.user.locked && player.user !== this) return; // ② 别人不许抢被锁的球员
  return origTake.call(this, player, state, globalOverride);
};
```

① 少了会"绑定可被引擎抢走"；② 少了会"每帧抛异常"。补丁打在**运行时**，811 KB 压缩包一行不动。

### 2.3.1 开赛前必须**不绑座**（P-2，party 流程的真 bug）

引擎的开球仪式是 `states.Kickoff`（继承 `WaitForPlayers`），它推进到 `Match` 的条件里有：

```js
pitch.allPlayersReady === true    // = isReady.send(players).every(...)
```

即**每个球员都要回答"我准备好了"**。而被我们接管（绑定）的球员坐在 `HumanMove` 里，回答是**否**。
于是在"手机先在大厅就位、大屏再进对局"这条**真实 party 路径**上，状态机会**永远卡在 `Kickoff`**：
`matchStarted` 不翻真、比赛时钟不走、进球/半场逻辑不生效——**表面上却像能玩**（因为每帧输入照样推得动球员）。

实测卡点（`script/lan-e2e.mjs` 抓出来的）：

```
state: "Kickoff", prepared: true, canPlay: true, play: false, allReady: false
playerStateTally: { HumanMove: 8, Ready: 4, RequestHuman: 1, Kickoff: 1 }
```

**修法**：席位**等哨响再上场**（`standalone-match.js` 里的 `acMatchLive()`）——
开赛前只登记不绑定（也**不**创建 user，因为未被绑定的 user 每帧被 `Team.assignPlayers` 抓去控球，会破坏同一个就绪判定）；
`matchStarted` 一旦为真整个比赛期间都为真（只有 `reset()` 重赛会清），所以之后不再有任何延迟。
`__acPadsState` 增加 `live` / `pending` 两个字段便于观测与断言。

> 这不是联机专属问题：任何"开球前就绑好的席位"都会踩到，1v1 的两台手柄同样在内。


### 2.4 头顶标签层（P3 的核心坑）

标签挂在 `stadium.topLayer`，14 个胶囊：号码人人都有，**真人**额外带昵称 + 席位色，AI 用中性石板灰 `#39404d`。
胶囊高度固定，所以"顶端尖角"的位置就是 `base - lift`，"lift 取多少"是唯一需要算对的东西。

**lift 怎么取？三个候选里只有一个是对的：**

| 候选                                     | 数值       | 结论                                   |
| -------------------------------------- | -------- | ------------------------------------ |
| `settings("PLAYER_HEIGHT") * PIXELS_Z` | ≈ 68     | ❌ 那是球员能停球的高度                         |
| `sprite.getLocalBounds().height * 0.5` | = 128    | ❌ 精灵是 256×256 RT 页，量的是**整页**，不是动物     |
| **读 RT 的像素找最上非透明行**                    | **≈ 35–43** | ✅ 这才是引擎真正画出来的高度                      |

实测方法（`renderToTexture()` 把脚放在 `ty = H - 10`，sprite `anchor(.5,1)`、`scale .5`）：

```js
lift = (rt.height - 最上非透明行) * |sprite.scale.y|
```

用 128 的后果被截图抓住了：标签浮在头顶上方约 **3.4 个身位**。用实测值后间隙是 **13–15.5 px**（`AC_LABEL_GAP_ABOVE_HEAD = 10`）。

采样策略：**每 tick 只测一个球员（轮询），前 60 tick 取最大值后冻结**。
全测 14 个会把开局那一秒拖卡；不冻结的话一次鱼跃会把全队标签一起抬高。

**独行 1v1（没有手机席位）时整层隐藏、一个都不画**，所以单人模式视觉上与改造前一模一样。

---

## 3. 分阶段进度与验收

| 阶段    | 内容                                  | 状态 | 验收证据                                                                  |
| ----- | ----------------------------------- | -- | --------------------------------------------------------------------- |
| P0    | Spike：造 user / 锁定守卫 / 头顶投影 三个假设      | ✅  | 三个假设全部成立，无代码落地                                                        |
| P1    | 中继扩容 + 分边席位协议                       | ✅  | `pnpm test:lan:seats` **57/57**；`script/lan-server.mjs`                |
| P2    | 主机桥 N 路输入 + 引擎固定绑定 + P-1 补丁         | ✅  | `pnpm test:lan:pad` **47/47**；真页面 + 真中继 + 8 台手机                        |
| P3    | 头顶号码/昵称/配色标签层 + HUD 开关              | ✅  | `pnpm test:lan:labels` **63/63**；截图 `.scratch/pad-labels.png`（标签贴头顶，无穿帮）  |
| P4    | 大厅双边席位面板 + 手机选号/绑定徽章                | ✅  | `pnpm test:lan:lobby` **61/61**；截图 `.scratch/pad-lobby.png`（手柄页"红队 3号"徽章） |
| P5    | 8-pad 并发回归 E2E（全流程 party 彩排）+ APK/README 收尾 | ✅  | `pnpm test:lan:e2e` **37/37**；截图 `.scratch/lan-e2e.png`。**抓出并修掉了"开球座卡死 `Kickoff`"（§2.3.1）**。APK 为 WebView 壳、无需重打包（版本仍 `1.0.0`）；README 已补 4v4 流程 / 测试表 / `inspect:match` 读法 |

**收尾说明**：
* APK **故意没有升版本**：`android-pad` 是 WebView 壳，`MainActivity` 直接加载在线的 `/pad?...` 页面，
  所以手柄 UI 的改动跟着网页走，不需要重新打包。`MainActivity.APP_VERSION` 与 `android-pad/version.json`
  必须**同时**改并配合真实重打包，否则已安装的设备会全部提示"发现新版本"。
* 新增诊断入口 `pnpm diag:lan:seats`（`script/diag-seat-errors.mjs`）：8 个假手柄静坐不动，
  打印 `users` / 队伍 / 占位台账和第一条引擎报错栈。它**不做断言**，是现场排障用的透镜，
  所以放在 `diag:` 前缀而不是 `test:`。

三条验收测试各自起**独立端口**的临时中继，通过 `window.__lanPort` 把页面指过去，
所以**永远不会碰你正在跑的 13001**，测的也永远是磁盘上的代码。

**为什么 `lan-e2e` 非写不可**：其余四个套件各只钉住一环，谁也不走"真实的一局"。
`lan-e2e` 走的链路是：大厅拿房间码 → 8 台手机按房间码入座 → 点开始 → 大屏切 `/match?lan=ROOM`
→ 引擎启动并绑 8 席（留 6 AI）→ 8 台并发推摇杆（位移 4.8~16.2，方向与各自摇杆一致、无人卡死）
→ 标签层 8 真人 / 6 AI → 零报错。它是唯一能抓住"每块单独都能用、但交接坏了"的测试——
上面那个 `Kickoff` 死锁就是这么被抓出来的。

---

## 4. 已知坑与注意事项

* **13001 上的中继是旧版**：新协议（`occupancy` / 手机 `pick`）要 `pnpm dev:lan` 重启才生效。
* `pnpm dev:lan` 会先删 `.next`；端口占用时 `EADDRINUSE` 用 `pnpm dev:lan:safe`。
* 测试**必须 headed Chrome**：无头 SwiftShader 会把引擎渲染循环卡死。
* 手机页**竖屏会被 rotate 遮罩挡住**（`PadClient` 的 `matchMedia("(orientation: portrait)")` 判定），这是产品行为，
  浏览器里验证手柄 UI 要用横屏视口。
* 引擎源码包 `match-runtime-source/` 从未提交且已被 gitignore，**找不回来了**；
  所以引擎侧只能在 `public/match-runtime-min/standalone-match.js` 这层胶水里改，
  好处是 811 KB 的压缩包不会被重新构建覆盖掉。
* 标签层的几何断言**不能自证**：测试自己用 `renderer.extract.pixels(renderTexture)` 重算一次角色高度，
  再去比标签位置。否则"用 lift 验证 lift"这种错法永远测不出来（P3 早期就是这么骗过自己的）。
* **开球仪式完成前不要绑座**（§2.3.1）。这是 party 流程最容易踩的坑，且**症状会骗人**：
  球员推得动、画面在动，看起来一切正常，实际比赛从未开始。
* `pitch.elapsed` 是**每帧增量**（`timeScale * dt`），不是时钟。要看"比赛在跑"请用
  `pitch.time`（计分板时钟）或 `pitch.simulationTime`。
* 手柄页的选号面板在**开赛后**只允许占空位（`taken`/`locked`），大厅里则随时可换号——
  这是有意的：开赛前是"集合"，开赛后是"上场"。
* 跑 headed 测试时**不要改 `app/` 下的代码**：Next dev 的 HMR 会让测试正在用的页面整页重载，
  Playwright 报 `Execution context was destroyed` 直接中断（`docs/`、`.scratch/`、`.workbuddy/` 不受影响）。
* 上面那条要**扩大到根目录配置**：Next dev 也盯 `package.json`（`next.config.mjs` 同理）。
  在一次 `pnpm test:lan:all` 期间顺手加了一行 script，dev server 重启导致
  `verify-pad-driver.mjs` 的 `pitch.update` 只被调到 1 次（`test1.stats.ticks = 1`），
  于是 `allMoved` / `eachPadMoved` 全红、还冒出 6 条 `Cannot take control` 假报错。
  **判断方法**：单独复跑绿 + 按 `A && B` 链式复跑也绿 ⇒ 是并发改动，不是产品 bug。
* i18n：`match.ctrl.*` 整组 HUD 文案（zoom / screenshot / mute / newmatch / 标签开关）**只有 zh/en 有**，
  pt/es/ja/fr 靠 `LocaleProvider` 的 `?? DICTS.en[key]` 回退成英文。这是历史状态，
  要么整组补翻译，要么别只补新加的那两个键。
