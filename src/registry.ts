/**
 * registry.ts — 注册表与派发判定（**纯逻辑**，无 IO、时间由调用方注入）
 *
 * 语义文档 §4.1/§4.3/§4.5 的代码形态。之所以把这些判定抽成无 IO 的纯函数：
 * 它们是「防线」——宿主必须能离线用坏样本证明「重名会拦、越权会拦、缺确认会拦、
 * 慢面板会降级」，而不是靠线上撞运气（AGENTS.md §5.9 §2 尸体测试纪律）。
 */
import type {
  ActionLevel, ActionSpec, PanelContribution, PanelFrontend, PanelHealth, PanelHealthSnapshot, PanelRequestHandler,
  PanelStyle, PanelSummary, ViewSpec,
} from './types.ts'
import { resolveAssetsDir } from './frontend.ts'
import type { PluginRootSource } from './frontend.ts'

/** 面板 id 形状：小写字母/数字/连字符（与命名规范一致）。 */
const PANEL_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** 强调色形状：只接受颜色字面量（CSS 注入面收敛为一个色值，不接受任何选择器/函数）。 */
const ACCENT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** 视图规格预算：块节点上限与嵌套深度上限（面板不可用超大视图拖垮外壳）。 */
export const VIEW_MAX_BLOCKS = 2000
export const VIEW_MAX_DEPTH = 8

/**
 * 校验面板自带视觉（fail-loud：样式字段是声明式契约，写错应当当场暴露而不是静默丢弃）。
 * @throws accent 形状非法或 density 取值非法
 */
export function assertValidStyle(panelId: string, style: PanelStyle | undefined): void {
  if (style === undefined) return
  if (style.accent !== undefined && !ACCENT_RE.test(style.accent)) {
    throw new Error(`panel "${panelId}": illegal style.accent "${style.accent}"（要求 #rgb / #rrggbb / #rrggbbaa）`)
  }
  if (style.density !== undefined && style.density !== 'comfortable' && style.density !== 'compact') {
    throw new Error(`panel "${panelId}": illegal style.density "${String(style.density)}"（要求 comfortable / compact）`)
  }
}

/** 视图规格校验结果。 */
export type ViewSpecCheck = { ok: true } | { ok: false; error: string }

/**
 * 校验前端接入声明（fail-loud，与 {@link assertValidStyle} 同风格）。
 *
 * 为什么非法值要抛而不是丢弃：`assetsDir` 写错（数字、空串）只有到请求 404 时才可见，
 * 而那时人看到的是"资源没了"，不是"配置写错了"——注册期抛错把因果摆在一起。
 * @throws frontend 不是对象，或 `assetsDir`/`entry` 不是非空字符串
 */
export function assertValidFrontend(panelId: string, frontend: PanelFrontend | undefined): void {
  if (frontend === undefined) return
  if (typeof frontend !== 'object' || frontend === null || Array.isArray(frontend)) {
    throw new Error(`panel "${panelId}": illegal frontend（要求对象 { assetsDir?, entry? }）`)
  }
  if (frontend.assetsDir !== undefined && (typeof frontend.assetsDir !== 'string' || frontend.assetsDir === '')) {
    throw new Error(`panel "${panelId}": illegal frontend.assetsDir "${String(frontend.assetsDir)}"（要求非空字符串）`)
  }
  if (frontend.entry !== undefined && (typeof frontend.entry !== 'string' || frontend.entry === '')) {
    throw new Error(`panel "${panelId}": illegal frontend.entry "${String(frontend.entry)}"（要求非空字符串）`)
  }
}

/**
 * 校验数据接口声明（fail-loud）。`handle` 存在但不是函数 = 声明错误，
 * 若不拦，症状会退化成"请求 404/500"，与"没声明"混成同一个现象（语义精确性）。
 * @throws `handle` 存在但不是函数
 */
export function assertValidHandler(panelId: string, handle: PanelRequestHandler | undefined): void {
  if (handle === undefined) return
  if (typeof handle !== 'function') {
    throw new Error(`panel "${panelId}": illegal handle（要求函数 (req) => Promise<{status, headers?, body}>）`)
  }
}

/** 需要至少一个数组字段的块类型（渲染器没有它就只能画空）。 */
const ARRAY_FIELDS: Record<string, string> = {
  sections: 'blocks',
  metrics: 'items',
  table: 'columns',
  list: 'items',
  kv: 'pairs',
  text: 'lines',
  timeline: 'events',
  actions: 'items',
  form: 'fields',
  chart: 'series',
  log: 'lines',
  progress: 'items',
  tabs: 'items',
}

/** 图的合法取值（渲染器只认这三种）。 */
const CHART_TYPES = new Set(['bar', 'line', 'donut'])

/**
 * 校验视图规格（**形状级**，不做语义裁决）。
 *
 * 纪律：未知 kind 放行（渲染器降级为"未知块"提示——白名单先小后扩，旧外壳不能被新块打崩），
 * 但**已知 kind 的必备数组字段必须存在**，否则面板会静默渲染成空块——那是"看起来成功"的失败。
 * @param spec - 面板返回的视图规格
 */
export function validateViewSpec(spec: unknown): ViewSpecCheck {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, error: '视图规格非法：不是对象' }
  }
  const blocks = (spec as ViewSpec).blocks
  if (!Array.isArray(blocks)) return { ok: false, error: '视图规格非法：缺少 blocks 数组' }

  let count = 0
  const walk = (list: unknown[], path: string, depth: number): ViewSpecCheck => {
    if (depth > VIEW_MAX_DEPTH) {
      return { ok: false, error: `视图规格非法：嵌套超过 ${String(VIEW_MAX_DEPTH)} 层（${path}）` }
    }
    for (let i = 0; i < list.length; i++) {
      count += 1
      if (count > VIEW_MAX_BLOCKS) {
        return { ok: false, error: `视图规格非法：块数量超过 ${String(VIEW_MAX_BLOCKS)}（${path}）` }
      }
      const block = list[i] as { kind?: unknown } | null
      if (block === null || typeof block !== 'object' || Array.isArray(block)) {
        return { ok: false, error: `视图规格非法：${path}[${String(i)}] 不是对象` }
      }
      const kind = block.kind
      if (typeof kind !== 'string' || kind === '') {
        return { ok: false, error: `视图规格非法：${path}[${String(i)}] 缺少字符串 kind` }
      }
      const field = ARRAY_FIELDS[kind]
      if (field !== undefined) {
        const value = (block as Record<string, unknown>)[field]
        if (!Array.isArray(value)) {
          return { ok: false, error: `视图规格非法：${path}[${String(i)}]（${kind}）缺少数组字段 ${field}` }
        }
        if (kind === 'sections') {
          const nested = walk(value, `${path}[${String(i)}].${field}`, depth + 1)
          if (!nested.ok) return nested
        }
        if (kind === 'tabs') {
          for (let t = 0; t < value.length; t++) {
            const item = value[t] as { blocks?: unknown } | null
            if (item === null || typeof item !== 'object' || !Array.isArray(item.blocks)) {
              return { ok: false, error: `视图规格非法：${path}[${String(i)}].${field}[${String(t)}] 缺少 blocks 数组` }
            }
            const nested = walk(item.blocks, `${path}[${String(i)}].${field}[${String(t)}].blocks`, depth + 1)
            if (!nested.ok) return nested
          }
        }
      }
      if (kind === 'chart') {
        const type = (block as { chart?: unknown }).chart
        if (typeof type !== 'string' || !CHART_TYPES.has(type)) {
          return { ok: false, error: `视图规格非法：${path}[${String(i)}]（chart）chart 必须是 bar/line/donut` }
        }
      }
      if (kind === 'form') {
        const actionId = (block as { actionId?: unknown }).actionId
        if (typeof actionId !== 'string' || actionId === '') {
          return { ok: false, error: `视图规格非法：${path}[${String(i)}]（form）缺少字符串 actionId` }
        }
      }
    }
    return { ok: true }
  }

  return walk(blocks, 'blocks', 1)
}

/** 判定面板 id 是否合法。 */
export function isValidPanelId(id: string): boolean {
  return PANEL_ID_RE.test(id)
}

/** 注册表条目（内部）。 */
export interface RegistryEntry {
  contribution: PanelContribution
  registeredAt: string
  snapshot: PanelHealthSnapshot
  /**
   * 贡献方插件的**绝对根目录**（注册时刻解析一次并记下，见 `frontend.ts` 的选择理由）。
   * 用途：解析相对 `frontend.assetsDir`、给出可审计的拒绝证据。
   */
  pluginRoot: string
  /** 上面这个值由哪一级锚点得出（`caller-module` / `config-tree` / `cwd`）。 */
  pluginRootSource: PluginRootSource
  /** `frontend.assetsDir` 解析后的**绝对**静态根；未声明 `frontend` = null。 */
  assetsRoot: string | null
}

/** 空健康快照（'unknown' = 还没有任何实测样本——不假装健康）。 */
export function emptySnapshot(): PanelHealthSnapshot {
  return { health: 'unknown', lastOkAt: null, lastError: null, lastDurationMs: null, sampleCount: 0 }
}

/**
 * 由实测样本推导健康度（纯函数）。
 * 规则（语义文档 §4.5）：无样本 → unknown；连续失败 ≥2 → down；一次失败或慢响应（>slowMs）→ degraded；否则 ok。
 * @param consecutiveFailures - 最近连续失败次数（成功即归零）
 * @param lastDurationMs - 最近一次成功取数耗时
 * @param slowMs - 慢响应阈值
 */
export function computeHealth(
  sampleCount: number,
  consecutiveFailures: number,
  lastDurationMs: number | null,
  slowMs = 1000,
): PanelHealth {
  if (sampleCount === 0) return 'unknown'
  if (consecutiveFailures >= 2) return 'down'
  if (consecutiveFailures === 1) return 'degraded'
  if (lastDurationMs !== null && lastDurationMs > slowMs) return 'degraded'
  return 'ok'
}

/** 参数声明校验结果。 */
export interface ParamCheck {
  ok: boolean
  params: Record<string, unknown>
  error?: string
}

/**
 * 按声明校验并**过滤**动作参数（未声明的键一律丢弃——不做"顺手透传"）。
 * @param spec - 动作的参数声明（未声明 = 该动作不收参数，任何参数都被丢弃）
 * @param raw - 请求携带的原始参数
 */
export function sanitizeParams(spec: Record<string, 'string' | 'number' | 'boolean'> | undefined, raw: unknown): ParamCheck {
  const out: Record<string, unknown> = {}
  if (spec === undefined) return { ok: true, params: out }
  if (raw === undefined || raw === null) return { ok: true, params: out }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, params: out, error: 'params 必须是对象' }
  const source = raw as Record<string, unknown>
  for (const [key, type] of Object.entries(spec)) {
    const value = source[key]
    if (value === undefined) continue
    if (type === 'string' && typeof value === 'string') { out[key] = value; continue }
    if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) { out[key] = value; continue }
    if (type === 'boolean' && typeof value === 'boolean') { out[key] = value; continue }
    return { ok: false, params: out, error: `参数 ${key} 类型应为 ${type}` }
  }
  return { ok: true, params: out }
}

/** 派发判定种类（把"拒绝的理由"也变成一等语义——语义精确性）。 */
export type DispatchDecisionKind =
  | 'run'
  | 'unknown-panel'
  | 'unknown-action'
  | 'requires-approval'
  | 'confirm-required'
  | 'bad-params'

/** 派发判定结果。 */
export interface DispatchDecision {
  kind: DispatchDecisionKind
  /** HTTP 语义状态码（宿主直接使用）。 */
  status: number
  /** 面向制作者的说明。 */
  message: string
  /** 校验后的参数（仅 kind==='run' 有意义）。 */
  params: Record<string, unknown>
  /** 命中审批门时给出的请示提示（供任务板/Telegram 通道复用）。 */
  approvalHint?: string
}

/**
 * 派发判定（纯函数，判定顺序即安全语义，不得随意调整）：
 * ① 面板存在 → ② 动作存在 → ③ 触及「须请示三类」→ 拒绝并转请示 → ④ destructive 缺确认 → 拒绝
 * → ⑤ 参数校验 → ⑥ 放行。**拒绝路径绝不触发任何副作用**（调用方据此保证 run 不被执行）。
 */
export function decideDispatch(
  action: ActionSpec | undefined,
  panelExists: boolean,
  panelTitle: string,
  input: { actionId: string; params?: unknown; confirm?: boolean },
): DispatchDecision {
  if (!panelExists) {
    return { kind: 'unknown-panel', status: 404, message: '未知面板', params: {} }
  }
  if (action === undefined) {
    return { kind: 'unknown-action', status: 404, message: `未知动作 ${input.actionId}`, params: {} }
  }
  if (action.requiresApproval === true) {
    return {
      kind: 'requires-approval',
      status: 403,
      message: `「${action.label}」触及须请示事项（删数据 / 动凭据 / 动核心引擎）——面板不得成为绕过主体性铁律的通道`,
      params: {},
      approvalHint: `【面板请示】${panelTitle} · ${action.label}：需爱丽丝在正常通道取得主人授权后执行`,
    }
  }
  if (action.level === 'destructive' && input.confirm !== true) {
    return { kind: 'confirm-required', status: 409, message: '破坏性动作需要二次确认（confirm=true）', params: {} }
  }
  const checked = sanitizeParams(action.params, input.params)
  if (!checked.ok) {
    return { kind: 'bad-params', status: 400, message: checked.error ?? '参数非法', params: {} }
  }
  return { kind: 'run', status: 200, message: 'ok', params: checked.params }
}

/** 注册表：贡献的生命周期与实测健康（无 IO；时间由调用方注入以便测试）。 */
export class PanelRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly failures = new Map<string, number>()

  /**
   * 注册一份贡献。
   *
   * `pluginRoot` 是**显式参数**而不是注册表自己猜的（AGENTS.md：默认值是显式 resolve 步骤）：
   * 由 `PanelHost` 在注册时刻从**调用方上下文**（`ctx.baseUrl`）与调用栈推导后传进来，
   * 解析结果随条目落档（`pluginRoot` / `pluginRootSource` / `assetsRoot`）——可审计、可断言。
   * @param contribution - 贡献声明
   * @param now - 注册时刻（ISO；时间由调用方注入以便测试）
   * @param pluginRoot - 插件根绝对路径（缺省 `process.cwd()`，便于纯单测与旧调用点）
   * @param pluginRootSource - 该根目录的来源
   * @throws id 非法或重复、style 非法、frontend/handle 声明非法、相对 assetsDir 越出插件根
   */
  register(
    contribution: PanelContribution,
    now: string,
    pluginRoot: string = process.cwd(),
    pluginRootSource: PluginRootSource = 'cwd',
  ): () => void {
    if (!isValidPanelId(contribution.id)) {
      throw new Error(`panel: illegal id "${contribution.id}"（要求 ${String(PANEL_ID_RE)}）`)
    }
    if (this.entries.has(contribution.id)) {
      throw new Error(`panel: duplicate panel id "${contribution.id}"`)
    }
    assertValidStyle(contribution.id, contribution.style)
    assertValidFrontend(contribution.id, contribution.frontend)
    assertValidHandler(contribution.id, contribution.handle)
    // §4.7 降级矩阵的最后一行：view / frontend / handle 三者都没给 ⇒ 注册 **fail-loud**。
    // 放行的话它在界面上是一张点进去什么都没有的卡片——又一种「看起来成功」的失败；
    // 宁可在注册那一刻响亮报错（该面板的贡献方必须至少选一种接入形态）。
    if (contribution.view === undefined && contribution.frontend === undefined && contribution.handle === undefined) {
      throw new Error(
        `panel "${contribution.id}": 必须至少声明 view / frontend / handle 之一（三者皆无 ⇒ 入口卡片点进去是空的）`,
      )
    }
    const declared = contribution.frontend?.assetsDir
    let assetsRoot: string | null = null
    if (declared !== undefined) {
      const assets = resolveAssetsDir(declared, pluginRoot)
      if (!assets.ok) {
        throw new Error(`panel "${contribution.id}": illegal frontend.assetsDir "${declared}"（${assets.reason}；pluginRoot=${pluginRoot}）`)
      }
      assetsRoot = assets.root
    }
    this.entries.set(contribution.id, {
      contribution, registeredAt: now, snapshot: emptySnapshot(), pluginRoot, pluginRootSource, assetsRoot,
    })
    this.failures.set(contribution.id, 0)
    return () => {
      this.entries.delete(contribution.id)
      this.failures.delete(contribution.id)
    }
  }

  /** 取贡献（未注册 → undefined）。 */
  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id)
  }

  /** 注册表投影（order 升序 → title 字典序；`__selfcheck` 之类宿主内置项由调用方单独处理）。 */
  list(): PanelSummary[] {
    return [...this.entries.values()]
      .map((e) => ({
        id: e.contribution.id,
        title: e.contribution.title,
        order: e.contribution.order ?? 100,
        ...(e.contribution.icon === undefined ? {} : { icon: e.contribution.icon }),
        ...(e.contribution.description === undefined ? {} : { description: e.contribution.description }),
        ...(e.contribution.style === undefined ? {} : { style: e.contribution.style }),
        ...(e.contribution.frontend === undefined ? {} : { frontend: e.contribution.frontend }),
        health: e.snapshot.health,
      }))
      .sort((a, b) => (a.order === b.order ? a.title.localeCompare(b.title) : a.order - b.order))
  }

  /** 记录一次取数实测（成功/失败 + 耗时），刷新健康度。只有宿主能写。 */
  recordView(id: string, ok: boolean, durationMs: number, error: string | null, now: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const failures = ok ? 0 : (this.failures.get(id) ?? 0) + 1
    this.failures.set(id, failures)
    const lastDuration = ok ? durationMs : entry.snapshot.lastDurationMs
    entry.snapshot = {
      health: computeHealth(entry.snapshot.sampleCount + 1, failures, lastDuration),
      lastOkAt: ok ? now : entry.snapshot.lastOkAt,
      lastError: ok ? null : (error ?? '未知错误'),
      lastDurationMs: lastDuration,
      sampleCount: entry.snapshot.sampleCount + 1,
    }
  }

  /** 实测健康快照（自检面板用）。 */
  health(): Array<PanelSummary & PanelHealthSnapshot> {
    return this.list().map((s) => {
      const entry = this.entries.get(s.id)
      return { ...s, ...(entry?.snapshot ?? emptySnapshot()) }
    })
  }
}

/** 空参数纠正助手：把动作的 params 声明转成渲染器用的动作块项。 */
export function actionItems(
  actions: Record<string, ActionSpec> | undefined,
): Array<{ actionId: string; label: string; level: ActionLevel }> {
  if (actions === undefined) return []
  return Object.entries(actions).map(([actionId, spec]) => ({ actionId, label: spec.label, level: spec.level }))
}
