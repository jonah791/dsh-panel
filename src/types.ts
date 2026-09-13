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
}

/** 注册表投影条目（/api/panel/registry 的元素）。 */
export interface PanelSummary {
  id: string
  title: string
  order: number
  icon?: string
  description?: string
  health: PanelHealth
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
