# dsh-plugin-mode-cycle

**Tab 正向循环、Shift+Tab 反向循环切换输入框模式（普通 ↔ 计划）** —— 对齐 opencode 的 `agent_cycle` / `agent_cycle_reverse`，切换**不写命令行记录**。

opencode 官方 keybinds 的定义（`https://opencode.ai/docs/keybinds/`）：

```json
"agent_cycle": "tab",
"agent_cycle_reverse": "shift+tab",
"prompt.autocomplete.complete": "tab"
```

注意第三行：opencode 自己也让 `tab` 同时承担「补全确认」，靠上下文仲裁——补全面板开着时 Tab 确认补全，否则 Tab 循环 agent。本插件在 DSH 里复刻的正是这套仲裁。

## 它做了什么

在 composer（输入框）里：

| 手势 | 菜单关闭时 | 遮罩打开时 |
|---|---|---|
| `Tab` | 前进一个模式 | 原样交给遮罩 |
| `Shift+Tab` | 后退一个模式 | 原样交给遮罩 |

两个模式下前进/后退互为对方的下一项，实际动作是向宿主路由请求一个**布尔模式值**：

| 当前模式 | 手势 | 请求 | 宿主派发 |
|---|---|---|---|
| 普通 | `Tab` / `Shift+Tab` | `active: true` | `/plan`（进入） |
| 计划 | `Tab` / `Shift+Tab` | `active: false` | `/plan off`（离开） |

只有真正推进了循环才 `preventDefault`。不满足条件时**一个字节都不吞**，原生焦点遍历完全保留。

## 机制（v0.3.0）：直调官方处理器，而非 `commands.execute`

```
浏览器 (client.js)                       宿主 (index.js)
  Tab / Shift+Tab
      └─ POST /plugin-mode-cycle/set ──► 校验 → ctx.agents.get(sessionId)
             { sessionId, active }              └─ ctx.commands.find(agent, 'plan').handler({
      ◄──── 200 { active, kind, text } ─────────     commandId, agent, rawInput, attachments: [], signal })
                                                    └─ 官方处理器内部：set(agent, …) → 写 plan/mode 事件
```

**为什么要绕开 `commands.execute`**：`execute()` 会在处理器运行前追加持久的 `command/run`、结算后追加 `command/done`，而核心的 `command` 对话定义（`kind: "command"`, `target: "chat"`）把这**一对事件**渲染成对话里的一行 `> plan · Plan mode on. Use /plan off to leave.`。直调 handler 只跳过这一对事件，**其余全部走官方实现**：同一个 handler、同样的 `plan/mode` 会话事件、同样的 `plan:policy` 提示词段落、同样的叙述消息。

`dsh-commands` 的 README 对 handler 的定位支持这条路径：注册项的 `input` 与 `handler` 是「discovery metadata and **direct UI handler**」，示例注释也写着 handler「runs directly against the agent; no model message is created」。

### 走过的弯路（v0.2.0 完全失效的原因，值得留档）

v0.2.0 试的是「按 `dsh-plan-mode` README 的说法直接驱动 `ctx.planMode`」，于是声明了 `inject: ['webServer', 'agents', 'planMode']`。结果**插件彻底不激活**：客户端模块照常出现在模块图里（那一项来自包的 `dsh.client` 清单），但宿主路由从未注册，`GET /plugin-mode-cycle/set` 永远 404，Tab 被吞而毫无反应。

根因是 cordis 的作用域规则：`dsh-plan-mode` 的 `lib/index.js` 以

```js
export { …, PlanModeController as default, … }
```

**把服务类作为 default 导出**，于是宿主在**那一行自己的上下文**上实例化它；服务只对注册它的上下文**子树**可见，而本插件的行是它的**兄弟**，永远注入不到。旁证：整套构建里**没有任何插件**在 `inject` 里声明过 `planMode`。
教训：`inject` 里写一个永远解析不了的服务名，会让 `apply` **静默永不执行**——没有报错，只有功能消失。

## 依据（均取自随包发布的源码与官方文档，不是猜的）

1. **composer 选择器**：dsh 0.1.5 起 composer 从 textarea 换成 Lexical `contenteditable`，渲染为 `[data-composer-card] [data-composer-input][contenteditable="true"]`；插件保留 textarea 兜底。
2. **命令注册表**：`ctx.commands`（`super(ctx, "commands")`）的公开方法有 `register` / `list(agent)` / **`find(agent, name)`** / `execute(agent, line, attachments, signal)` / `view(agent)`；`find` 返回命令定义，`execute` 才是追加 `command/run`+`command/done` 的地方。
3. **处理器的调用形状**（`execute` 内部）：`{ commandId, agent, rawInput, attachments, signal }`。
4. **`plan` 处理器语义**：`rawInput === 'off'` 离开、空串进入；带附件的 `off` 会被拒（本插件始终传空附件，故不会被拒）。
5. **会话 → agent**：`ctx.agents.get(sessionId)`（该注册表以 session id 为键）。
6. **宿主路由**：`ctx.webServer.register({ kind: 'exact', path, handler })` 返回 disposer；插件注册顶层精确路由的先例见社区的 `dsh-keyboard-manager`（`/plugin-config/dsh-keyboard-manager`）。
7. **状态是会话投影**：slot 组件用 `useProjection('plan')` 读 `{ active, pending }`，`pending` 含义是「请求的变更尚未生效」，官方折叠为 `pending ? !active : active`（`foldPlan()` 逐字镜像）。
8. **菜单仲裁**：slash / 触发菜单打开期间键盘归它所有——行用 Tab 选定，`Escape`/`Shift+Tab` 离开且不选定；**没有高亮项时 Tab 原样放行**。菜单根节点带 `data-trigger-menu`。
9. **请求守卫**：`ctx.connection.requestRejection(req)` 返回应拒绝的状态码，或 `undefined` 表示放行。

## 协议（本插件自有路由）

### `POST /plugin-mode-cycle/set`

`content-type: application/json`，body `{ "sessionId": string, "active": boolean }`。

| 状态 | 含义 |
|---|---|
| `200` | `{ active, kind, text }`；`kind`/`text` 是官方处理器返回的结果类型与原样文本 |
| `400` | body 不是 JSON 对象、`sessionId` 非非空字符串、`active` 非布尔 |
| `405` | 非 POST（响应带 `allow: POST`） |
| `409` | 会话未运行，或该 profile 未注册 `/plan` 命令 |
| `413` | body 超过 1 KiB |
| `500` | 处理器抛错（已 `ctx.logger.warn`，不泄露堆栈） |

### `GET /plugin-mode-cycle/health`

报告解析结果，用于诊断「Tab 没反应」。可带 `?sessionId=<id>` 额外探测该会话的 `/plan` 命令是否可解析：

```sh
curl -s 'http://127.0.0.1:<port>/plugin-mode-cycle/health?sessionId=<session-id>'
# {"ok":true,"services":{"webServer":true,"agents":true,"commands":true},"planCommand":true}
```

`planCommand` 为 `false` 而 `commands` 为 `true`，说明命令注册表可达但 `/plan` 没注册（计划模式包未挂载）；`ok:false` 说明 `agents`/`commands` 任一不可达，插件本不该激活到这一步。

## 诊断手法（本次排障实证有效）

宿主端口会随重启变化（`DSH_WEB_URL` 也会刷新），先确认端口与路由：

```sh
lsof -nP -iTCP -sTCP:LISTEN | grep -i electron     # 找监听端口
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/plugin-mode-cycle/health   # 404 = 宿主半边未激活
curl -sN -m 5 http://127.0.0.1:<port>/plugins/events | grep -o '"id":"[^"]*"'               # 客户端模块图
```

两个关键判读：
- **`/plugins/events` 返回 200** 证明「插件运行期注册路由」机制本身正常（它是核心 client-HMR 注册的），因此本插件路由的 404 只可能是自己没注册；
- **模块图里有本插件、但健康路由 404** = 客户端清单可见而宿主 `apply` 未执行，典型原因就是 `inject` 解析失败。

## 设计取舍

- **监听在冒泡阶段（bubble），不是捕获阶段。** 核心与其它 composer 插件挂得更深，因此它们先决策；本插件用 `event.defaultPrevented` 判断这个 Tab 是否已被拿走。这样既不会抢走 slash 菜单的 Tab，也不会破坏 `dsh-input-assist` 那类用 Tab 采纳幽灵补全的插件。
- **不在失败时回退到 `/plan` 命令。** 否则记录行会「有时出现、有时不出现」，比稳定的失败更难判断。失败只 `console.debug` 一行，模式不变。
- **不用投影的 `pending` 做门禁。** `pending` 表示「请求的变更尚未生效」；拿它当门禁会吞掉退出手势（v0.1.0 实测踩过）。现在只有本地请求在途（`inFlight`）才吞键。
- **状态未知就不出手。** 若 `plan` 投影一次都没观测到（`seen === false`），插件不抢 Tab——盲发请求可能和别处发起的状态变更打架。
- **桥接槽不占官方位置。** 桥接组件注册在 `conversation.input.left`（只读投影、渲染 null），官方 `PlanChip` 在 `conversation.input.plan`；两者不争位。
- **不画按钮/指示器。** 计划模式下官方 `PlanChip` 已经在负责显示状态。

## 代价与边界

- **「The user switched this session to plan mode.」这类叙述消息仍会出现，且无法由本插件消除。** 这是 `PlanModeController.narration()` 按设计写入会话的用户消息（模型正是通过它得知模式变更），任何入口——包括官方 `PlanChip`、手动敲 `/plan`、本插件的 Tab——都会产生。本插件只消除命令行那一行。
- **`/plan <message>`**（带一条指令进入计划模式）不覆盖：Tab 只切模式，不代发消息。
- **命令目录里的 `/plan` 记录**不再出现在手势路径上（直接敲 `/plan` 仍然照常记录）。
- 多了一层自有路由与两个半边协作的面；handler 的调用形状若在未来版本改变，Tab 会静默失效（有日志、无记录行、不污染会话）——刻意的失败模式。
- **计划评审进行中切换没有意义**：计划已呈交、等你选 `Approve` / `Keep planning` 时，批准或反馈才是主路径。
- **请求在途时按 Tab 会吞键不发第二次请求**（`inFlight`），避免两个方向相反的变更叠在一起。
- **草稿与附件不受影响。** 官方 `/plan off` 带附件会被拒（为保护草稿）；本插件始终以空附件调用处理器，因此不会触发该拒绝，草稿与附件卡始终原样保留。

## 安装 / 回滚

`dsh plugin` 的参数直接转发给 pnpm，因此支持任意 pnpm 来源。CLI 的名字随分发方不同（纯 CLI 是 `dsh`，桌面应用会各起一个名字，如 `yxt`、`yxt-test`），profile 名通常是 `desktop`：

```sh
# 本地目录（开发时用，装成 link:，改动重启即生效）
dsh plugin --profile desktop add /path/to/dsh-plugin-mode-cycle

# GitHub（可指名 tag）
dsh plugin --profile desktop add github:DrWang1/dsh-plugin-mode-cycle
dsh plugin --profile desktop add github:DrWang1/dsh-plugin-mode-cycle#v0.3.0

# npm（若已发布到 npm）
dsh plugin --profile desktop add dsh-plugin-mode-cycle

# 回滚
dsh plugin --profile desktop remove dsh-plugin-mode-cycle
```

该命令会把包装进 profile 的 `node_modules` 并追加到 `dsh.profile.bundles`；插件行由本包自带的 `cordis.patch.yml` 提供，不需要手改 profile 的 patch 文件。

> 本地目录安装是 `link:`——源码改动经重启即生效；GitHub / npm 安装是**固定副本**，升级必须重新 `add` 新的 tag。

### 重启语义（重要）

| 改了哪半边 | 生效方式 |
|---|---|
| `client.js`（客户端） | **刷新页面**即可（没跑 `pnpm run dev:web` 时客户端插件不会热加载） |
| `index.js`（宿主） | **必须重启应用**，宿主半边不会因刷新页面而重新加载 |

注意：`desktop` profile 由 Electron 应用独占管理，`--profile desktop --dump-config` 会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`），所以验证宿主侧只能靠上面的健康路由。

## 配置与扩展

- **加第三个模式**：在 `client.js` 的 `MODES` 追加一项、在 `WANTED_FOR` 给对应布尔值；宿主只需在 `inputFor()` 里补上该模式对应的命令参数（当前是空串/`off`）。
- **换目标命令**：`index.js` 的 `PLAN_COMMAND` / `OFF_INPUT`。
- **换仲裁选择器**：`client.js` 的 `OVERLAY`，当前 `[data-trigger-menu], [data-conversation-composer-overlay]`。
- **换按键**：目前硬编码 Tab / Shift+Tab（`event.key === 'Tab'`，用 `shiftKey` 判方向）。
- **换路由路径**：`index.js` 与 `client.js` 各有一个 `ROUTE` 常量，必须同时改（测试会校验顶层性）。

## 验证状态

**已真机实测（v0.1.0 的仲裁链路）**：Tab 能进入并退出计划模式 ✔。它证明了客户端模块加载正常、`conversation.input.left` 桥接拿到了 `sessionId` 与 `plan` 投影、冒泡期监听与 `defaultPrevented` 仲裁生效——「核心无条件吞 Tab 导致静默失效」这一风险不成立。**这套仲裁代码在后续版本中未改动。**

**已修复的两个真机缺陷**：
1. v0.1.0「能进不能出」——把 `/plan` 当 toggle（实际 `/plan` 进入、`/plan off` 离开）＋ `pending` 门禁吞掉退出键；
2. v0.2.0「Tab 完全没反应」——`inject: ['planMode']` 永远解析不了导致 `apply` 静默不执行（根因见上文「走过的弯路」）。

**已自动化校验**：36 条测试全绿——客户端 19 条（循环回绕、`pending` 折叠、模式→布尔映射、请求体、路由路径、composer 归属、遮罩判定）+ 宿主 17 条（服务声明、模式→参数映射、方法限制、body 校验矩阵、query 解析、健康载荷、读取上限与提前停止）。`node --check` 与 manifest 契约（`./client`、`./locale/*.json`、`./icon`）通过。

**已真机实测（v0.3.0）**：Tab / Shift+Tab 能进能出计划模式，且对话里**不再新增 `> plan · …` 命令行** ✔。宿主路由的激活也已确认：重启后两个路由的响应从「框架的空 body 404」变为本插件的鉴权响应，说明处理器已在位；浏览器侧的 `fetch` 以启动时换取的同源 cookie 通过鉴权（官方客户端同样依赖该 cookie，其请求使用 `credentials: "include"`）。

**未逐项完成的验证**：我无法在本机 curl 读取健康路由的 `ok` / `planCommand` 载荷——启动 token 在页面加载时已消耗并换成 HttpOnly cookie，无法复现一个已鉴权请求。因此「健康载荷的具体内容」属实现推断，其余行为均已真机确认。

**手动对照（可自行复核）**：敲 `/plan` 应仍产生命令行——确认只改了手势路径，没有篡改命令行为。

**仍会出现的**：「The user switched this session to plan mode.」叙述消息（预期内，见「代价与边界」）。

**安装状态**：已安装进 `desktop` profile（软链 + `dsh.profile.bundles`）。

## 被否决的替代方案

- **`inject: [...'planMode']` 直驱服务**：见「走过的弯路」——服务作用域使其对兄弟行永不可见。
- **覆盖 `command/run`/`command/done` 的渲染定义来隐藏那些行**：这些是核心持久事件，且与手动压缩（compaction）行共用同一个 `command` 定义，覆盖属未文档化行为，可能连带破坏无关的命令行显示。
- **给 `dsh-plan-mode` 加配置静音**：该包 config schema 只接受 `section`，加字段会导致加载失败。
- **纯 CSS/DOM 隐藏**：这些行由 React 从持久事件渲染，DOM 层面隐藏既脆弱又只影响本机渲染（其它客户端、导出、fork 后仍会出现）。
- **客户端在失败时回退到命令路径**：见「设计取舍」。