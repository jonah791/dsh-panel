<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 面板宿主（Panel Host）：一个 URL（/panel/）+ 一套外壳 + 一张注册表 + 视图规格/动作 ABI/派发审计/实测健康；其他插件只提交「声明」而不各写前端；内置 5 个面板（插件管理/任务板/养成档案/分身/面板审计）
  inject: 'webServer'
  tools: 无工具（提供 ctx.panel 服务 + HTTP 面）
  runtime: host + client（自带外壳资源与客户端 bundle，零官方 client 依赖）
  envDeps: 运行期零依赖；构建期 Node 脚本 scripts/copy-assets.mjs、scripts/bundle-client.mjs
  boundary: 不是官方 Web GUI 的替代品（对话/会话仍在官方界面）；不是沙箱（贡献方同进程、享有完整权限——能力 ≠ 沙箱）；不认业务逻辑（只认视图规格与动作 ABI）；不得成为绕过主体性铁律的通道（触及「须请示三类」的动作宿主拒绝派发）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6 / dsh-host-webserver ^0.1.0-rc.6
-->
# dsh-panel — 面板宿主（Panel Host）

<p align="center">
  <a href="https://github.com/jonah791/dsh-panel"><img src="https://img.shields.io/badge/version-0.4.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-65%20passed-brightgreen" alt="tests">
</p>

**一句话**：把各插件**各自不同的前端**聚合到一处入口（一屏按钮/卡片），并把请求**转发**给对应插件的**中转站**——一个 URL（`http://127.0.0.1:3080/panel/`）、一套外壳、一张注册表；宿主**不规定插件前端长什么样**：贡献方可以**自带前端**（静态资源 + 自己的数据接口，宿主原样托管与反代、不解析不注入不重写），也可以只提交**声明**（ViewSpec + 动作表）由宿主以「轻量模式」渲染。

**为什么值得用**：自研前端散落各处时，没有人能回答「谁在什么时候对哪个页面做了什么」——安全机制不可观测就等于不存在。本插件把「入口聚合 / 静态托管 / 请求反代 / 派发 / 审计 / 实测健康」收进一个宿主，同时**不剥夺插件对自己前端的支配权**：**贡献方声明即 effect**（插件卸载面板立刻消失，无幽灵），**未知动作零副作用**，**破坏性动作要二次确认**，**触及「须请示三类」的动作宿主直接拒绝并转请示通道**。而且它**零官方 client 依赖**——官方前端坏了，面板照常可用。

> ⚠ **定位沿革（诚实记录）**：v0.4 及以前，宿主是**唯一渲染者**（「每个插件提交一份声明，宿主负责渲染」）。2026-09-22 主人定调「面板插件不是让前端格式锁死，而是因为需要**聚合**。**各个插件前端都应该不同**。就类似**中转站**」+「别做成 tab 页」⇒ 定位反转为**入口聚合 + 静态托管 + 请求反代**，呈现权威归还插件，`ViewSpec` 降级为可选轻量模式。详见 [`docs/semantic.md`](docs/semantic.md) §11.10/§11.11。

## 能力

**宿主职责**：托管外壳与插件静态资源（`/panel-assets/<id>/…`，**按插件根**做穿越校验）· 把插件数据请求反代给它自己的 `handle`（`/api/panel/<id>/*`；未声明 → **404 不回落不猜测**）· 维护注册表（含实测健康）· 把只给声明的贡献 `view()` 渲染成视图规格（轻量模式）· 按动作 ABI 派发并**每次落一条审计** · 施加超时与降级。

**接入契约**（消费方视角；完整签名见 [`docs/semantic.md`](docs/semantic.md) §4）：

```ts
// 必须用 ctx.inject 等待宿主（不得用 ctx.get('panel') 一次性探测——加载顺序会让它拿到 undefined 且永不重试）
ctx.inject(['panel'], (panelCtx) => {
  // 三种接入形态（§4.7 降级矩阵）：只给 view ⇒ 轻量模式；只给 frontend/handle ⇒ 全托管；
  // 都给 ⇒ 入口卡片点进去加载你自带的前端，view() 仅供宿主做聚合摘要。三者皆无 ⇒ 注册 fail-loud。
  panelCtx.panel.register({
    id: 'my-panel',                 // 全局唯一 [a-z0-9-]+，重复注册 fail-loud
    title: '我的面板',
    order: 100,                     // 入口卡片排序（小→前）
    icon: 'plug',                   // **语义名**（宿主渲染成字母徽标），不是自由 SVG/emoji
    description: '一句话用途',

    // ── 形态 A：自带前端（宿主原样托管，不解析、不注入、不重写）──
    frontend: { assetsDir: 'web/my-panel', entry: 'index.html' },  // assetsDir 相对**你的插件根**（推荐用绝对路径显式给出）
    handle: (req) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }),
    // handle 收到的是**纯数据**信封 {method,path,query,headers,body}（不给 Node 原生 req/res）——
    // 于是你的数据面可以脱离 HTTP 服务器被离线单测。

    // ── 形态 B：只提交声明（宿主以「轻量模式」渲染）──
    view: async (params) => ViewSpec,
    actions: { /* 动作表 */ },
    style: { accent: '#f472b6' },   // 可选：自带视觉（宿主只认 token，不认自由 CSS）
  })                                // 返回 disposer；注册即 effect
})
```

**HTTP 面**（全部 JSON 响应统一信封 `{ok, ...}`）：

| 方法 | 路径 | 语义 |
|------|------|------|
| GET | `/panel/` | 外壳 HTML（独立资源文件；`cache-control: no-store`） |
| GET | `/panel/assets/*` | 宿主静态资源（prefix 路由，白名单目录，禁路径穿越） |
| GET | `/api/panel/registry` | 注册表投影：`[{id,title,order,icon,description,health}]`（**不含**视图规格） |
| GET | `/api/panel/view?id=` | `{ok, spec, generatedAt, durationMs, degraded?}` |
| POST | `/api/panel/action` | 派发动作（校验 `panelId`/`actionId`，写审计） |
| GET | `/api/panel/selfcheck` | 宿主自检：贡献健康实测 + 宿主版本 + 计时统计 |

**内置面板（宿主自带，随宿主注册）**：

| id | 标题 | order | 说明 |
|----|------|-------|------|
| `plugin-manager` | 插件管理 | 10 | 自研插件清单/构建态与挂载态（启停经 patch + 哨兵生效） |
| `taskboard` | 任务板 | 20 | 板面与流转：计数、分布图、新建/认领/完成、终态归档 |
| `growth-profile` | 养成档案 | 30 | 自我模型 + 记忆规模 + 周目存档 + 技能/插件规模（只读） |
| `agent-teams` | 分身 | 40 | 成员状态、任务清单与 inbox 积压（只读） |
| `audit` | 面板审计 | 50 | 宿主自己的派发审计（只读，不提供改写通道） |

**降级语义**：贡献方 `view()` 抛错 → 该面板显示错误原文，**外壳与其余面板不受影响**；`view()` 超过 `viewTimeoutMs` → 标记超时；未知 `panelId`/`actionId` → 400/404 且**零副作用**（但仍写一条审计）。

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-panel": "link:<工作区>/self-plugins/dsh-panel"
```

**2) 挂组合**（零配置可用；下列项按需覆盖）：

```yaml
- id: panel
  name: dsh-panel
  config:
    defaultProfile: web
```

**3) 30 秒验证**：

```bash
curl -s http://127.0.0.1:3080/api/panel/registry | head -c 300
# 期望：{"ok":true,"host":{"version":"0.4.0","startedAt":"…"},"panels":[…5 个面板…]}
curl -s http://127.0.0.1:3080/api/panel/selfcheck
# 期望：ok:true + 各贡献健康度实测 + 宿主版本
```

浏览器打开 `http://127.0.0.1:3080/panel/` → 期望左侧导航 5 项、点任意一项能出内容（而非空壳或 404）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 宿主开关 |
| `dshHome` | `''`（→ `$DSH_HOME` → `~/.dsh`） | DSH 主目录解析起点 |
| `profilesDir` | `''`（→ `<dshHome>/profiles`） | profile 目录（插件管理面板用） |
| `selfPluginsDir` | `''`（→ `<workspace>/self-plugins`） | 自研插件目录（插件管理面板用） |
| `defaultProfile` | `web` | 默认 profile 名 |
| `viewTimeoutMs` | `2000` | 取视图超时（超时 → 该面板降级，外壳不受阻） |
| `actionTimeoutMs` | `10000` | 派发动作超时 |

## 落盘与自证（出问题时先看这里）

**审计轨**：每次派发写一行到 **`<DSH_HOME>/panel/audit.jsonl`**（写盘吞错不反噬派发）：

```json
{"at":"2026-09-13T09:41:30.712Z","panelId":"taskboard","actionId":"claim","level":"write",
 "paramsDigest":"83b51b5ad28488cd","outcome":"ok","durationMs":1,"message":"已认领 t-2a6731ae（claimed，负责人 alice）"}
```

| 字段 | 含义 |
|------|------|
| `at` / `panelId` / `actionId` | 何时、对哪个面板的哪个动作 |
| `level` | 动作分级（`read`/`write`/`destructive`）——决定是否要二次确认 |
| `paramsDigest` | 参数**摘要**（不落原文，避免把敏感值写进日志） |
| `outcome` | `ok` / `denied` / `error`（**被拦下也有行**——这才是审计的意义） |
| `durationMs` / `message` | 耗时与人类可读结果/拒绝理由 |

本机实测（2026-09-14）：`audit.jsonl` 4 行，末行即上例。

**一条命令答五问**（本插件是生态里的**正面样板**——五问全可答）：

```bash
tail -3 "$DSH_HOME/panel/audit.jsonl"; curl -s http://127.0.0.1:3080/api/panel/registry
# ① 线上跑的是哪个构建 → registry 的 host.version + host.startedAt（实测 0.4.0 / 2026-09-14T07:06:07Z）
# ② 谁发起 / 投给谁   → audit 的 panelId + actionId + at
# ③ 断在哪一段        → audit 的 outcome（ok/denied/error）+ message；view 断点看 view 响应的 degraded
# ④ 结果质量          → /api/panel/selfcheck 的实测健康 + 该面板是否 degraded
# ⑤ 耗时与预算        → audit 的 durationMs（动作）与 view 响应的 durationMs（视图，对照 viewTimeoutMs=2000）
```

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. 行为级：`GET /api/panel/registry` 返回 `ok:true` 且 `panels` 为你预期的数量（本机 5 个）+ `host.version` 与 `package.json` 一致；
2. 页面级：浏览器打开 `/panel/` 能切到任意面板并看到内容（**截图复核**，别只看接口——单测全绿时缺陷仍可能只在视觉层暴露）；
3. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）的 `liveNow` 含本插件。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。本插件构建含两步（`tsc` + `copy-assets.mjs`，客户端另有 `bundle-client.mjs`），只跑 `tsc` 会得到一个**没有外壳资源**的宿主。

**回退**（三档）：
- 组合级：preset 给 `panel` 行加 `disabled: true` → 面板整体下线，**官方 Web GUI 完全不受影响**（本插件从不修改官方界面）；
- 源码级：`git -C self-plugins/dsh-panel revert <commit>` → 重新构建（含 assets/client）→ 预检 → 哨兵重启；
- 数据级：`audit.jsonl` 可随时删除（纯审计，无业务状态）；贡献方数据不归宿主，宿主从不持久化它们。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**51 例离线测试**（8 个文件）：

| 文件 | 例数 | 覆盖 |
|------|-----|------|
| `registry.test.mjs` | 12 | 注册表核心：非法 id / **重复 id fail-loud**（不静默覆盖）、`dispose` 后消失（无幽灵）、排序与投影形状、健康度迁移（含恢复） |
| `taskboard-write.test.mjs` | 9 | 写入通道：**板面解析失败 → 拒绝写入、写前写后字节相同**（只读可宽容、写入必须苛刻）、并发写、终态归档 |
| `taskboard.test.mjs` | 6 | 板面视图：计数/分布形状、空板与坏行降级 |
| `viewspec-validation.test.mjs` | 6 | 视图规格校验：已知 kind 缺必备字段 / `chart` 取值非法 / `form` 缺 `actionId` / 超块数与超嵌套 → 降级；未知 kind 放行 |
| `audit-panel.test.mjs` | 5 | 审计页：坏行逐行跳过并计数、`limit` 边界（非法→默认、越界→夹到 500）、>512KB 只读尾部并如实标注 |
| `client-bundle.test.mjs` | 5 | 零官方 client 依赖：产物 grep + 外壳体积 + 无公网请求断言 |
| `panel-style.test.mjs` | 5 | 皮肤层：`?theme=` 优先级、非法 `accent` **注册 fail-loud**、切主题不丢标签页选择 |
| `panels-expressiveness.test.mjs` | 3 | 表现力块族：块组合渲染、超块数上限降级 |

**无网络依赖**：视图/动作/审计全在离线夹具上断言（临时目录 + 桩贡献方）。

## 设计要点

- **注册即 effect，卸载即消失**：面板身份是合成级契约——宿主不持久化贡献方数据，插件禁用后面板立刻从注册表消失，**绝不出现「幽灵面板」**。
- **重复 id 必须 fail-loud**：第二个同 id 注册抛错而不是覆盖——撞车 = 配置错误，静默覆盖会让「谁在渲染」变成不可知的谜。
- **必须用 `ctx.inject(['panel'], …)` 等待宿主，不得 `ctx.get('panel')`**：加载顺序会让一次性探测拿到 `undefined` 且永不重试，表现为「插件健康但面板 404」——这是实践踩出来的接入纪律。
- **只读可宽容，写入必须苛刻**：板面解析失败时**拒绝写入**（写前写后字节相同），否则空板会覆盖真实数据；读取时坏行跳过并计数即可。
- **审批门优先于确认门**：触及「须请示三类」（删数据/动凭据/动核心引擎）的动作，即使调用方带了 `confirm:true` 也**拒绝派发**（`requires-approval`）——宿主不得成为绕过主体性铁律的通道。
- **审计是安全机制的可观测面**：被拦下的动作也写行（`denied`），并且**参数只落摘要**（`paramsDigest`）不落原文——记录了「做过什么」又不制造新的泄露面。
- **零官方 client 依赖**：外壳是自包含资源（本机实测 `lib/assets/shell.html` **97,311 字节**，`/panel/` 一次返回 97,311 字符、`cache-control: no-store`），构建期才需要 Node 脚本——官方前端坏了面板照常可用，代价是自带一套资源与构建步骤。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约（453 行）**：定位与负边界、术语、概念模型、**注册契约 / 视图规格 / 动作 ABI / HTTP 面 / 前端接入契约 §4.7 / 失效降级 / 皮肤层（逐条 `[MUST]`）**、信任与安全边界（含能力诚实声明）、与官方 GUI 的关系、迁移路径、**可证伪验收 17 条（已证 13 · 待线上 4）**、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `ui-visual-verification` | 界面视觉与交互验收（几何/对比度/跨刷新状态/真实副作用四类断言 + 截图复核清单）——**单测全绿时三个缺陷全靠看图发现的教训** |
| 技能 `dsh-panel-plugin` | 面板插件开发方法论（webServer 托管 + 独立资源 + 同源 fetch + 命名规范），本插件的前身 |
| 技能 `semantic-doc-first` | 先写「是什么」再让实现逼近它、用实践回修文档的方法（本插件是该方法的第一号实践） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态。
