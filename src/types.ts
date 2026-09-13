/**
 * types.ts — 面板宿主的对外契约类型（语义文档 §2/§4 的代码形态）
 *
 * 只放类型，无运行期代码（对齐 DSH 约定：src/types.ts 仅类型）。
 * 任何字段增删 = 契约变更：必须同步 docs/semantic.md 的版本与偏离日志。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 面板健康度：由宿主**实测**得出，贡献方无权自报（语义文档 §4.5）。 */
export type PanelHealth = 'ok' | 'degraded' | 'down' | 'unknown'

/** 视觉基调（渲染器的 tone 语义）。 */
export type Tone = 'ok' | 'warn' | 'bad' | 'muted'

/** 视图规格块（白名单：宿主唯一渲染对象，§4.2）。 */
export type ViewBlock =
  | { kind: 'sections'; title?: string; blocks: ViewBlock[] }
  | { kind: 'metrics'; title?: string; items: Array<{ label: string; value: string; hint?: string; tone?: Tone }> }
  | { kind: 'table'; title?: string; columns: Array<{ key: string; label: string; align?: 'left' | 'right' }>; rows: Array<Record<string, unknown>>; rowActions?: string[] }
  | { kind: 'list'; title?: string; items: Array<{ title: string; subtitle?: string; tags?: string[]; tone?: Tone }> }
  | { kind: 'kv'; title?: string; pairs: Array<{ key: string; value: string }> }
  | { kind: 'text'; title?: string; lines: string[] }
  | { kind: 'timeline'; title?: string; events: Array<{ at: string; title: string; detail?: string; tone?: Tone }> }
  | { kind: 'actions'; title?: string; items: Array<{ actionId: string; label: string; level: ActionLevel }> }
  // ---- 表现力扩展块（v0.5）：脱离官方皮肤束缚后的自由度，但**仍是声明式** ----
  /** 声明式表单：字段与提交都绑定到一个已声明的动作（面板因此从"能看"变"能干活"）。 */
  | {
    kind: 'form'
    title?: string
    /** 提交时要存在于此面板动作表中的 action id（不存在 → 按钮禁用并说明原因）。 */
    actionId: string
    submitLabel?: string
    note?: string
    fields: Array<{
      /** 参数名：必须与动作 params 声明一致，否则被宿主参数白名单丢弃。 */
      name: string
      label: string
      type?: 'text' | 'textarea' | 'number' | 'checkbox' | 'select'
      /** select 的选项（字符串或 {value,label}）。 */
      options?: Array<string | { value: string; label?: string }>
      placeholder?: string
      required?: boolean
      hint?: string
      /** 宽字段（占满整行）。 */
      wide?: boolean
    }>
  }
  /** 图形块：零依赖内联 SVG（bar / line / donut）——数值由面板给出，画法由宿主负责。 */
  | { kind: 'chart'; title?: string; chart: 'bar' | 'line' | 'donut'; series: Array<{ label: string; value: number; tone?: Tone }>; unit?: string; height?: number }
  /** 日志块：等宽尾部视图（严重度着色），适合审计/构建/事故回放。 */
  | { kind: 'log'; title?: string; lines: Array<{ at?: string; level?: 'info' | 'ok' | 'warn' | 'error' | 'debug'; text: string }> }
  /** 量表块：进度/占比条（渲染层把值夹到 [0,max]——不信任输入）。 */
  | { kind: 'progress'; title?: string; items: Array<{ label: string; value: number; max?: number; tone?: Tone; hint?: string }> }
  /** 标签页块：把多个块分组（**纯客户端切换**，不产生额外请求）。 */
  | { kind: 'tabs'; title?: string; items: Array<{ label: string; badge?: string; blocks: ViewBlock[] }> }

/** 面板自带视觉（声明式、有形状校验——宿主不接受任意 CSS）。 */
export interface PanelStyle {
  /** 强调色：仅接受 `#rgb` / `#rrggbb` / `#rrggbbaa`（CSS 注入面收敛为一个颜色字面量）。 */
  accent?: string
  /** 密度：comfortable（默认）/ compact（面板自报"我信息密度高"）。 */
  density?: 'comfortable' | 'compact'
}

/** 视图规格：JSON 可序列化（无函数/DOM/HTML），宿主渲染的唯一输入。 */
export interface ViewSpec {
  blocks: ViewBlock[]
}

/** 动作分级：read 只读 / write 有副作用 / destructive 不可逆（需二次确认）。 */
export type ActionLevel = 'read' | 'write' | 'destructive'

/** 动作运行期上下文。 */
export interface ActionContext {
  /** 触发面板的会话 id（若可从请求推断）。 */
  sessionId?: string
  /** 派发时刻（ISO）。 */
  now: string
}

/** 动作结果：data 必须可序列化，宿主只做 JSON 文本呈现。 */
export interface ActionResult {
  ok: boolean
  data?: unknown
  message?: string
}

/** 一个动作声明（§4.3）。 */
export interface ActionSpec {
  label: string
  level: ActionLevel
  /** 声明式参数（宿主据此校验；未声明的参数一律丢弃）。 */
  params?: Record<string, 'string' | 'number' | 'boolean'>
  /** 该动作是否触及「须请示三类」（删数据 / 动凭据 / 动核心引擎）——触及则宿主拒绝派发并转请示（§5.4）。 */
  requiresApproval?: boolean
  run: (params: Record<string, unknown>, ctx: ActionContext) => Promise<ActionResult> | ActionResult
}

/** 一份面板贡献（§4.1）。 */
export interface PanelContribution {
  /** 全局唯一 id，`[a-z0-9-]+`；重复注册 fail-loud。 */
  id: string
  title: string
  order?: number
  icon?: string
  description?: string
  /** 取数：返回视图规格。宿主施加超时与错误隔离。 */
  view: (params: Record<string, string>) => Promise<ViewSpec> | ViewSpec
  /** 可执行动作表。 */
  actions?: Record<string, ActionSpec>
  /** 自带视觉（可选）：accent 颜色 + 密度。宿主校验形状后落到该面板容器上。 */
  style?: PanelStyle
}

/** 注册表投影条目（/api/panel/registry 的元素）。 */
export interface PanelSummary {
  id: string
  title: string
  order: number
  icon?: string
  description?: string
  health: PanelHealth
  /** 面板自带视觉（原样投影；形状校验在注册时完成）。 */
  style?: PanelStyle
}

/** 贡献的实测健康快照（只由宿主写入）。 */
export interface PanelHealthSnapshot {
  health: PanelHealth
  lastOkAt: string | null
  lastError: string | null
  lastDurationMs: number | null
  sampleCount: number
}

/** 面板宿主服务（ctx.panel）——消费方唯一入口。 */
export interface PanelHostService {
  /** 注册一份面板贡献；返回 disposer（解除注册）。 */
  register: (contribution: PanelContribution) => () => void
  /** 注册表投影（含实测健康）。 */
  list: () => PanelSummary[]
  /** 取某面板的视图规格（含超时/降级语义）。 */
  view: (id: string, params?: Record<string, string>) => Promise<ViewOutcome>
  /** 派发动作（含分级校验、审批门、审计）。 */
  dispatch: (input: DispatchInput) => Promise<DispatchOutcome>
  /** 实测健康快照（自检面板用）。 */
  health: () => Array<PanelSummary & PanelHealthSnapshot>
}

/** view() 结果信封。 */
export interface ViewOutcome {
  ok: boolean
  spec: ViewSpec | null
  generatedAt: string
  durationMs: number
  degraded: boolean
  error: string | null
}

/** 派发输入。 */
export interface DispatchInput {
  panelId: string
  actionId: string
  params?: Record<string, unknown>
  confirm?: boolean
  sessionId?: string
}

/** 派发结果。 */
export interface DispatchOutcome {
  ok: boolean
  status: number
  message?: string
  data?: unknown
  error?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    panel: PanelHostService
  }
}

/** 便捷别名（消费方 import 用）。 */
export type PanelContext = Context
