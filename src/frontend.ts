/**
 * frontend.ts — 插件前端接入的**纯逻辑**（无 IO：路径解析、插件根推导、中转判定）
 *
 * 语义文档 §4.7 的代码形态：宿主只管三件事——**给入口、托管资源、转发请求**。
 * 之所以抽成纯函数（对齐 registry.ts 的纪律）：这三件事都是**防线**——
 * 路径穿越必须能离线用坏样本证明"它真的会拦"（AGENTS.md §5.9 §2 尸体测试纪律）。
 * IO（existsSync / readFileSync / HTTP）留在 host.ts 与 index.ts。
 *
 * 路径分隔符纪律（Windows 是已知坑）：所有包含判定一律用 `path.resolve` 规范化后的
 * **绝对路径 + `sep` 前缀**，并对 win32 做大小写折叠；`\` 在 URL 中一律视为穿越尝试。
 *
 * @module dsh-panel/frontend
 */
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PanelRequestHandler } from './types.ts'

/** 静态资源按扩展名给出的 Content-Type（未知扩展名 → application/octet-stream）。 */
export const ASSET_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
}

/** 未知扩展名的兜底类型（不做 404：插件的前端可能带任意二进制资源）。 */
export const ASSET_MIME_FALLBACK = 'application/octet-stream'

/**
 * 由文件名/相对路径推出 Content-Type。
 * @param file - 文件名或路径（只看扩展名）
 * @returns MIME 字符串；未知扩展名返回 {@link ASSET_MIME_FALLBACK}
 */
export function contentTypeFor(file: string): string {
  return ASSET_MIME[extname(file).toLowerCase()] ?? ASSET_MIME_FALLBACK
}

/** `child` 是否就是 `parent` 或位于其下（Windows 大小写不敏感）。 */
function isInside(child: string, parent: string): boolean {
  const fold = process.platform === 'win32' ? (s: string): string => s.toLowerCase() : (s: string): string => s
  const c = fold(child)
  const p = fold(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** 插件根目录的来源（谁提供的锚点）。 */
export type PluginRootSource = 'caller-module' | 'config-tree' | 'cwd'

/** 插件根目录解析结果。 */
export interface PluginRoot {
  /** 绝对路径。 */
  root: string
  /** 该值由哪一级锚点得出（审计与排障用——失败可见，不静默）。 */
  source: PluginRootSource
}

/** 调用栈里要跳过的帧（三类：框架包根、宿主服务模块文件、框架路径段）。 */
export interface StackExclusions {
  /** 服务框架（Cordis）之类会插入代理帧的包根——它们不是贡献方。 */
  roots?: readonly string[]
  /** 宿主**服务模块本身**（`host.ts` 的文件路径）：它永远紧贴服务方法，不是贡献方。 */
  files?: readonly string[]
  /** 路径段兜底（如 `cordis`）：框架根解析失败时仍能跳过框架帧。 */
  segments?: readonly string[]
}

/**
 * 从 V8 调用栈文本里取**贡献方模块**的文件路径。
 *
 * 必须跳过的三类帧（否则解析出的"插件根"会是框架或宿主自己）：
 *   - 宿主服务模块（`PanelHost.register` 自己所在文件）；
 *   - 服务框架（Cordis）的代理层——`ctx.panel.register(...)` 会先进入框架的 Proxy apply 陷阱，
 *     该帧位于宿主与贡献方**之间**（实测：`vendor/cordis/lib/types/utils.js`）；
 *   - 由 `roots`/`segments` 声明的一切框架路径。
 * **不**跳过宿主包的其他模块：宿主**内置面板**就是从宿主包内注册的（如 `panels/audit.ts` 声明
 * `assetsDir: 'web/audit'`），它们的插件根**就是宿主包根**——跳过整个宿主包会把它们的相对路径指错。
 * @param stack - `new Error().stack` 的文本（undefined = 运行时未提供栈）
 * @param exclude - 要跳过的帧（见 {@link StackExclusions}）
 * @returns 贡献方模块文件绝对路径；找不到返回 undefined
 */
export function callerModuleFile(stack: string | undefined, exclude: StackExclusions = {}): string | undefined {
  if (stack === undefined) return undefined
  const roots = exclude.roots ?? []
  const files = exclude.files ?? []
  const segments = (exclude.segments ?? []).map((s) => `${sep}${s.toLowerCase()}${sep}`)
  const re = /(file:\/\/[^\s()"']+?):\d+:\d+/g
  for (const match of stack.matchAll(re)) {
    const url = match[1]
    if (url === undefined) continue
    let file: string
    try {
      file = fileURLToPath(url)
    } catch {
      continue
    }
    if (roots.some((root) => isInside(file, root))) continue
    const folded = `${sep}${file.toLowerCase()}${sep}`
    if (segments.some((segment) => folded.includes(segment))) continue
    if (files.some((skip) => isInside(file, skip))) continue
    return file
  }
  return undefined
}

/**
 * 从模块文件向上找最近的 `package.json` 所在目录（= 插件包根）。
 * @param file - 模块文件绝对路径
 * @param exists - 存在性判定（注入以便离线测试）
 * @returns 包根绝对路径；到根目录仍无 `package.json` 则 undefined
 */
export function packageRootOf(file: string, exists: (path: string) => boolean): string | undefined {
  let dir = dirname(file)
  while (true) {
    if (exists(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 解析贡献方插件的根目录（**显式 resolve 步骤**——AGENTS.md：默认值必须是显式步骤，不隐式猜）。
 *
 * 为什么是这个优先级（选择与理由）：
 *  ① `caller-module`：从**调用栈**取贡献方的模块文件，向上找最近的 `package.json`。
 *     这是唯一能指向"插件包目录"的锚点——Cordis 的 `ctx.baseUrl` 在 DSH 里是**组合树锚点**
 *     （`boot/app-boot` 把它设成 cordis.yml 所在目录，即 `.dsh/profiles/<profile>/`），
 *     而自研插件住在 `self-plugins/<pkg>/`（经 profile 的 node_modules 软链挂载）。
 *     拿组合树目录当插件根，`assetsDir: 'web'` 会解析到 profile 下的 `web/`——**静默指错**，
 *     属于"看起来成功"的失败。栈帧里的路径是 Node 解析后的真实路径（软链已解开），
 *     所以它对跨目录挂载也成立；宿主内置面板的调用方就是宿主包的模块，解析结果自然落在宿主包根。
 *  ② `config-tree`：栈推导失败（运行时不给栈 / 帧被裁剪）时退回 `ctx.baseUrl`
 *     （file: URL → 目录，或非目录 URL → 其 dirname）。该值对"资产就放在组合目录旁"的插件可用。
 *  ③ `cwd`：两者都缺时的兜底。**兜底不是静默**——来源随条目落进注册表（`pluginRootSource`），
 *     `/panel-assets/<id>/…` 的拒绝审计也会带上解析后的绝对路径。
 *
 * 推荐写法仍是**绝对 `assetsDir`**（贡献方用 `import.meta.url` 自算）——显式优先于推导。
 * @param input - 栈、baseUrl、cwd、存在性判定与要跳过的帧
 * @returns 插件根目录与其来源
 */
export function resolvePluginRoot(input: {
  stack?: string
  baseUrl?: string
  cwd: string
  exists: (path: string) => boolean
  exclude?: StackExclusions
}): PluginRoot {
  const caller = callerModuleFile(input.stack, input.exclude)
  if (caller !== undefined) {
    const root = packageRootOf(caller, input.exists)
    if (root !== undefined) return { root, source: 'caller-module' }
  }
  if (input.baseUrl !== undefined) {
    try {
      const url = new URL(input.baseUrl)
      if (url.protocol === 'file:') {
        const abs = fileURLToPath(url)
        return { root: url.pathname.endsWith('/') ? resolve(abs) : dirname(resolve(abs)), source: 'config-tree' }
      }
    } catch {
      // 非 URL 的 baseUrl（或坏 URL）不是错误：直接落到 cwd 兜底，来源会如实记录
    }
  }
  return { root: resolve(input.cwd), source: 'cwd' }
}

/** `frontend.assetsDir` 的解析结果。 */
export type AssetsResolution = { ok: true; root: string } | { ok: false; reason: string }

/**
 * 把 `frontend.assetsDir` 解析成**绝对**静态根。
 * 纪律（§4.7-2「前缀校验要按插件根做」）：相对路径**不得**越出插件根；
 * 想指向别处就必须显式给绝对路径（显式优先于隐式）。
 * @param assetsDir - 声明的静态目录（绝对或相对插件根）
 * @param pluginRoot - 插件根绝对路径
 * @returns 绝对静态根，或拒绝原因
 */
export function resolveAssetsDir(assetsDir: string | undefined, pluginRoot: string): AssetsResolution {
  if (assetsDir === undefined || assetsDir === '') return { ok: false, reason: 'assets-undeclared' }
  if (assetsDir.includes('\0')) return { ok: false, reason: 'bad-path' }
  if (isAbsolute(assetsDir)) return { ok: true, root: resolve(assetsDir) }
  const root = resolve(pluginRoot, assetsDir)
  if (!isInside(root, pluginRoot)) return { ok: false, reason: 'assets-escape-plugin-root' }
  return { ok: true, root }
}

/** 请求路径的解码结果。 */
export type DecodedPath = { ok: true; path: string } | { ok: false; reason: string }

/**
 * 解码请求路径（`decodeURIComponent` 会对坏转义抛错——这里转成可判定的拒绝）。
 * 宿主**只解码一次**：解码后的字符串交给 {@link resolvePanelAsset} 做穿越校验。
 * @param pathname - `URL.pathname`（未解码）
 * @returns 解码后的路径，或拒绝原因
 */
export function decodeRequestPath(pathname: string): DecodedPath {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { ok: false, reason: 'bad-encoding' }
  }
  if (decoded.includes('\0')) return { ok: false, reason: 'bad-path' }
  return { ok: true, path: decoded }
}

/**
 * 把 `/panel-assets/<id>/<rest>` 或 `/api/panel/<id>/<rest>` 拆成 id 与命名空间内路径。
 * @param path - 已解码的请求路径
 * @param prefix - 路由前缀（如 `/panel-assets`）
 * @returns `{ id, rest }`（rest 无前导 `/`，可为空串）；前缀不匹配或 id 缺失时 undefined
 */
export function splitPanelPath(path: string, prefix: string): { id: string; rest: string } | undefined {
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return undefined
  const tail = path.slice(prefix.length).replace(/^\/+/, '')
  if (tail === '') return undefined
  const at = tail.indexOf('/')
  if (at === -1) return { id: tail, rest: '' }
  return { id: tail.slice(0, at), rest: tail.slice(at + 1) }
}

/** 静态资产解析结果。 */
export type AssetResolution = { ok: true; file: string } | { ok: false; status: number; reason: string }

/**
 * 解析 `/panel-assets/<id>/<rest>` 的目标文件。
 *
 * 越界一律 **404**（不区分"文件不存在"与"越界"对外表现——不向请求方泄漏目录结构），
 * 但 reason 如实记进审计。拒绝面：
 *   - 未声明 `frontend` → `no-frontend`
 *   - 空路径 / 含 `\0` / 含 `\`（URL 用 `/`；反斜杠在 Windows 上是分隔符，混入即视为穿越尝试）
 *   - 绝对路径或盘符路径
 *   - `path.resolve` 后仍在静态根之外（`../` 的真实防线）
 * @param assetsRoot - 该插件的静态根（`null` = 未声明 frontend）
 * @param rest - 命名空间内相对路径（已解码；空串 = 请求入口页，由调用方补 `entry`）
 * @returns 目标绝对路径，或拒绝（含 HTTP 状态）
 */
export function resolvePanelAsset(assetsRoot: string | null | undefined, rest: string): AssetResolution {
  if (assetsRoot === null || assetsRoot === undefined || assetsRoot === '') return { ok: false, status: 404, reason: 'no-frontend' }
  if (rest === '') return { ok: false, status: 404, reason: 'empty-path' }
  if (rest.includes('\0')) return { ok: false, status: 404, reason: 'bad-path' }
  if (rest.includes('\\')) return { ok: false, status: 404, reason: 'backslash-path' }
  if (isAbsolute(rest) || /^[a-zA-Z]:/.test(rest)) return { ok: false, status: 404, reason: 'absolute-path' }
  const target = resolve(assetsRoot, rest)
  if (!isInside(target, assetsRoot)) return { ok: false, status: 404, reason: 'path-escape' }
  return { ok: true, file: target }
}

/** 反代判定结果。 */
export type ForwardPlan =
  | { kind: 'forward'; handle: PanelRequestHandler }
  | { kind: 'reject'; status: number; reason: 'unknown-panel' | 'no-handle'; message: string }

/**
 * `/api/panel/<id>/*` 的转发判定（**不回落、不猜测**，§4.7-3）。
 * 未注册的 id 与"注册了但没声明 handle"都给 404——宿主不替插件猜一个数据源，
 * 也不把请求转给别的面板（那是跨插件越权）。
 * @param contribution - 该 id 的贡献声明（`undefined` = 未注册）
 * @param panelId - 路径里的面板 id
 * @returns 放行（带 handle）或拒绝（带状态与原因）
 */
export function planForward(
  contribution: { handle?: PanelRequestHandler } | undefined,
  panelId: string,
): ForwardPlan {
  if (contribution === undefined) {
    return { kind: 'reject', status: 404, reason: 'unknown-panel', message: `未知面板 ${panelId}` }
  }
  if (typeof contribution.handle !== 'function') {
    return {
      kind: 'reject',
      status: 404,
      reason: 'no-handle',
      message: `面板 ${panelId} 未声明 handle —— /api/panel/${panelId}/* 不回落、不猜测`,
    }
  }
  return { kind: 'forward', handle: contribution.handle }
}
