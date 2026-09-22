/**
 * host.ts — 面板宿主服务（ctx.panel）
 *
 * 语义文档 §4.1/§4.3/§4.5 的实现：注册表 + 取数（超时/错误隔离）+ 派发（分级/审批门/审计）。
 * 设计纪律：
 *   - **健康度只由实测写**（registry.recordView），贡献方自报状态不参与判定；
 *   - 单面板失败绝不影响外壳与其他面板（超时用 Promise.race，且吞掉迟到 reject 防未捕获异常）；
 *   - 拒绝路径零副作用：判定先于 run（decideDispatch 的语义）。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PanelRegistry, decideDispatch, validateViewSpec } from './registry.ts'
import type { RegistryEntry } from './registry.ts'
import { packageRootOf, resolvePluginRoot } from './frontend.ts'
import type { PluginRoot } from './frontend.ts'
import { appendAudit, digestParams } from './audit.ts'
import type {
  ActionContext, ActionResult, DispatchInput, DispatchOutcome, PanelContribution, PanelHostService,
  PanelSummary, ViewOutcome, PanelHealthSnapshot, ViewSpec,
} from './types.ts'

/** 宿主服务模块自身的文件（注册调用栈里紧贴服务方法的那一帧——不是贡献方）。 */
const HOST_MODULE_FILE = fileURLToPath(import.meta.url)

/**
 * 服务框架（Cordis）包根：`ctx.panel.register(...)` 会先经过框架 Proxy 的 apply 陷阱，
 * 于是调用栈里夹着**框架自己的帧**（实测 `vendor/cordis/lib/types/utils.js`）。
 * 不排除它，栈推导会把"贡献方"认成 Cordis——进而把 `assetsDir` 解析到框架目录里。
 * @param specifier - 包名
 * @returns 包根绝对路径；解析不到返回 undefined（由 `excludeSegments` 的路径段兜底）
 */
function frameworkRootOf(specifier: string): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve(specifier)
    return packageRootOf(entry, existsSync)
  } catch {
    // 解析不到不是错误：兜底规则（路径段 `cordis`）仍在，来源会如实记录
    return undefined
  }
}

/** Cordis 包根（可能为 undefined——见 {@link frameworkRootOf}）。 */
const CORDIS_PACKAGE_ROOT = frameworkRootOf('@deepseek-ai/cordis')

/** 宿主运行参数。 */
export interface PanelHostOptions {
  /** 取数超时（ms）：超过即判定该面板降级，不阻塞其余面板。 */
  viewTimeoutMs: number
  /** 动作执行超时（ms）。 */
  actionTimeoutMs: number
  /** 审计目录（DSH_HOME/panel）。 */
  auditDir: string
  /** 慢响应阈值（ms）：超过即把面板标为 degraded。 */
  slowMs: number
  /** 宿主版本（自检面板展示）。 */
  version: string
  /** 宿主启动时刻。 */
  startedAt: string
}

/** 宿主默认参数。 */
export const DEFAULT_HOST_OPTIONS: Omit<PanelHostOptions, 'auditDir' | 'version' | 'startedAt'> = {
  viewTimeoutMs: 2000,
  actionTimeoutMs: 10_000,
  slowMs: 1000,
}

/** 把任意抛出物转成可读文本。 */
function errText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * 带超时的求值：迟到的 reject 被吞掉（避免未捕获异常炸 web），返回值携带是否超时。
 * 导出给中转路由复用（`/api/panel/<id>/*` 的转发也必须有超时——否则一个挂住的插件会占着连接）。
 * @param fn - 被求值的取数/执行/转发函数
 * @param timeoutMs - 超时阈值
 */
export async function withTimeout<T>(fn: () => Promise<T> | T, timeoutMs: number): Promise<{ ok: true; value: T; timedOut: false } | { ok: false; error: unknown; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined
  try {
    const value = await Promise.race<T>([
      Promise.resolve().then(fn),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`timeout after ${timeoutMs}ms`)) }, timeoutMs)
      }),
    ])
    return { ok: true, value, timedOut: false }
  } catch (error) {
    return { ok: false, error, timedOut: errText(error).includes('timeout after') }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 面板宿主服务。消费方：`inject: ['panel']` + `ctx.effect(() => ctx.panel.register({...}))`。
 */
export class PanelHost extends Service implements PanelHostService {
  private readonly registry = new PanelRegistry()

  constructor(ctx: Context, private readonly opts: PanelHostOptions) {
    super(ctx, 'panel')
  }

  /**
   * 注册一份面板贡献。调用方应包在 `ctx.effect(() => ...)` 里以获得卸载即注销的生命周期。
   *
   * 注册时刻顺带解析**贡献方插件的根目录**（`frontend.assetsDir` 的相对锚点）：
   * 选择与理由见 `frontend.ts` 的 `resolvePluginRoot`（首选调用栈推导 → 次选 `ctx.baseUrl` → cwd 兜底）。
   * 注意这里依赖 Cordis 的 tracker 语义：服务方法内 `this.ctx` 是**调用方**的上下文
   * （`getTraceable`/`createShadowMethod` 把 `ctx` 覆写成调用方上下文），所以 `this.ctx.baseUrl`
   * 读的是贡献方的锚点而不是宿主的。
   * @throws id 非法或重复、style/frontend/handle 声明非法、相对 assetsDir 越出插件根
   */
  register(contribution: PanelContribution): () => void {
    const root = this.pluginRootOf()
    return this.registry.register(contribution, new Date().toISOString(), root.root, root.source)
  }

  /**
   * 取注册表条目（**宿主内部**：中转路由据此拿 `assetsRoot` / `handle`）。
   * 不放进 `PanelHostService`：消费方不需要感知宿主的静态托管理路。
   * @param id - 面板 id
   */
  panel(id: string): RegistryEntry | undefined {
    return this.registry.get(id)
  }

  /** 解析贡献方插件根目录（栈由 `new Error().stack` 捕获，框架帧与宿主服务帧被跳过）。 */
  private pluginRootOf(): PluginRoot {
    const stack = new Error().stack
    const baseUrl = this.ctx.baseUrl
    return resolvePluginRoot({
      ...(stack === undefined ? {} : { stack }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      cwd: process.cwd(),
      exists: existsSync,
      exclude: {
        ...(CORDIS_PACKAGE_ROOT === undefined ? {} : { roots: [CORDIS_PACKAGE_ROOT] }),
        files: [HOST_MODULE_FILE],
        segments: ['cordis'],
      },
    })
  }

  /** 注册表投影（含实测健康）。 */
  list(): PanelSummary[] {
    return this.registry.list()
  }

  /**
   * 取某面板的视图规格：超时/抛错 → `ok:false` + degraded（外壳据此渲染降级态），其余面板不受影响。
   * @param id - 面板 id
   * @param params - 取数参数（字符串表；贡献方自行解释）
   */
  async view(id: string, params: Record<string, string> = {}): Promise<ViewOutcome> {
    const generatedAt = new Date().toISOString()
    const started = Date.now()
    const entry = this.registry.get(id)
    if (entry === undefined) {
      return { ok: false, spec: null, generatedAt, durationMs: 0, degraded: true, error: '未知面板（可能已卸载）' }
    }
    // 全托管模式（§4.7）：只声明 frontend/handle 的插件没有 view()。这不是故障——
    // 但**不记健康样本**（无样本 = unknown，比伪造一个 ok 诚实），只在信封里说明出口在哪。
    const view = entry.contribution.view
    if (view === undefined) {
      return {
        ok: false, spec: null, generatedAt, durationMs: 0, degraded: true,
        error: '该面板未声明 view()（全托管模式）——请直接访问其前端入口 /panel-assets/' + id + '/',
      }
    }
    const result = await withTimeout(() => view(params), this.opts.viewTimeoutMs)
    const durationMs = Date.now() - started
    if (!result.ok) {
      const error = result.timedOut ? `取数超时（>${String(this.opts.viewTimeoutMs)}ms）` : errText(result.error)
      this.registry.recordView(id, false, durationMs, error, generatedAt)
      return { ok: false, spec: null, generatedAt, durationMs, degraded: true, error }
    }
    const spec = result.value
    // 形状校验（v0.5）：块数量/嵌套深度/已知 kind 的必备数组字段。
    // 为什么在这一层拦：面板静默渲染成空块是"看起来成功"的失败——宿主宁可响亮降级。
    const check = validateViewSpec(spec)
    if (!check.ok) {
      this.registry.recordView(id, false, durationMs, check.error, generatedAt)
      return { ok: false, spec: null, generatedAt, durationMs, degraded: true, error: check.error }
    }
    this.registry.recordView(id, true, durationMs, null, generatedAt)
    return { ok: true, spec: spec as ViewSpec, generatedAt, durationMs, degraded: durationMs > this.opts.slowMs, error: null }
  }

  /**
   * 派发动作：判定（存在性 / 审批门 / 确认 / 参数）→ 执行 → 审计。
   * @param input - 派发输入
   */
  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    const at = new Date().toISOString()
    const entry = this.registry.get(input.panelId)
    const action = entry?.contribution.actions?.[input.actionId]
    const decision = decideDispatch(action, entry !== undefined, entry?.contribution.title ?? input.panelId, input)
    if (decision.kind !== 'run') {
      appendAudit(this.opts.auditDir, {
        at, panelId: input.panelId, actionId: input.actionId, level: action?.level ?? 'unknown',
        paramsDigest: digestParams(input.params), outcome: 'denied', reason: decision.kind, durationMs: 0,
        message: decision.message, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      })
      return {
        ok: false,
        status: decision.status,
        error: decision.message,
        ...(decision.approvalHint === undefined ? {} : { data: { approvalHint: decision.approvalHint } }),
      }
    }
    const started = Date.now()
    const actionCtx: ActionContext = { now: at, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) }
    const result = await withTimeout<ActionResult>(() => action!.run(decision.params, actionCtx), this.opts.actionTimeoutMs)
    const durationMs = Date.now() - started
    if (!result.ok) {
      const error = result.timedOut ? `动作超时（>${String(this.opts.actionTimeoutMs)}ms）` : errText(result.error)
      appendAudit(this.opts.auditDir, {
        at, panelId: input.panelId, actionId: input.actionId, level: action!.level,
        paramsDigest: digestParams(input.params), outcome: result.timedOut ? 'timeout' : 'error', durationMs,
        message: error, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      })
      return { ok: false, status: 500, error }
    }
    const value = result.value
    appendAudit(this.opts.auditDir, {
      at, panelId: input.panelId, actionId: input.actionId, level: action!.level,
      paramsDigest: digestParams(input.params), outcome: value.ok ? 'ok' : 'error', durationMs,
      message: value.message ?? '', ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    })
    return {
      ok: value.ok,
      status: value.ok ? 200 : 400,
      ...(value.message === undefined ? {} : { message: value.message }),
      ...(value.data === undefined ? {} : { data: value.data }),
      ...(value.ok ? {} : { error: value.message ?? '动作失败' }),
    }
  }

  /** 实测健康快照（自检面板用）。 */
  health(): Array<PanelSummary & PanelHealthSnapshot> {
    return this.registry.health()
  }

  /** 宿主自身信息（自检面板头部）。 */
  hostInfo(): { version: string; startedAt: string; viewTimeoutMs: number; actionTimeoutMs: number } {
    return {
      version: this.opts.version,
      startedAt: this.opts.startedAt,
      viewTimeoutMs: this.opts.viewTimeoutMs,
      actionTimeoutMs: this.opts.actionTimeoutMs,
    }
  }
}
