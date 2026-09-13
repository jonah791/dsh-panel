/**
 * dsh-panel — 面板宿主（Panel Host · v0.2）
 *
 * 语义文档：docs/semantic.md（本文件是它的实现形态；冲突时先登记偏离日志再决定改谁）。
 * 主人 2026-09-12 定调：前端统一走这个宿主——其他插件不再各写一套界面，只提交一份「声明」。
 *
 * 三条通道：
 *   ① 主通道 = 本宿主独立页 `/panel/`（零官方 client 依赖，官方升级不易碎）
 *   ② 增强通道 = 官方 index-inject 行（M3 评估，尚未实施）
 *   ③ 不采用 = 官方 client slot（版本对齐成本已量化）
 *
 * 权威划分（语义文档 §3）：数据权威归消费方；呈现权威归宿主；**健康权威归宿主实测**。
 *
 * @module dsh-panel
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { PanelHost } from './host.ts'
import { createPluginManagerPanel } from './panels/plugin-manager.ts'
import type { PluginManagerDeps } from './panels/plugin-manager.ts'
import { createTaskboardPanel } from './panels/taskboard.ts'
import { createGrowthProfilePanel } from './panels/growth-profile.ts'
import { createAgentTeamsPanel } from './panels/agent-teams.ts'
import type { ViewSpec } from './types.ts'

/** 宿主版本（自检面板与 registry 展示，与 package.json 同步维护）。 */
export const VERSION = '0.2.0'

export const name = 'agent-panel'
export const inject = ['webServer'] as const

export interface Config {
  enabled: boolean
  dshHome: string
  profilesDir: string
  selfPluginsDir: string
  /** 面板操作与展示的默认目标 profile。 */
  defaultProfile: string
  /** 取数超时（ms）：超过即判该面板降级，不阻塞其余面板（语义文档 §4.5）。 */
  viewTimeoutMs: number
  /** 动作执行超时（ms）。 */
  actionTimeoutMs: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  dshHome: z.string().default(''),
  profilesDir: z.string().default(''),
  selfPluginsDir: z.string().default(''),
  defaultProfile: z.string().default('web'),
  viewTimeoutMs: z.natural().default(2000),
  actionTimeoutMs: z.natural().default(10_000),
})

// ---------- 路径解析 ----------
function dshHomeOf(cfg: Config): string {
  return cfg.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
}
function workspaceOf(cfg: Config): string {
  return resolve(dshHomeOf(cfg), '..')
}
function profilesDirOf(cfg: Config): string {
  return cfg.profilesDir || join(dshHomeOf(cfg), 'profiles')
}
function selfPluginsDirOf(cfg: Config): string {
  return cfg.selfPluginsDir || join(workspaceOf(cfg), 'self-plugins')
}

// ---------- 资产（独立文件，永不嵌 TS 模板字符串：dsh-panel-plugin 技能铁律） ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

/** 资产目录候选（构建产物优先，开发态兜底）。 */
function assetDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url)) // lib/
  return [join(here, 'assets'), join(here, '..', 'src', 'assets')]
}

/**
 * 读取一份外壳资产。
 * @param relPath - 相对资产目录的文件名（已由调用方做过穿越校验）
 * @returns 文本内容或 undefined（缺失 → 调用方返回 500 并显示可读提示）
 */
function readAsset(relPath: string): string | undefined {
  for (const dir of assetDirs()) {
    const file = join(dir, relPath)
    if (existsSync(file)) {
      try { return readFileSync(file, 'utf8') } catch { /* 继续找 */ }
    }
  }
  return undefined
}

// ---------- HTTP 辅助 ----------
function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

function html(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try { resolvePromise(JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 自检面板（宿主内置，id 固定，不参与注册表避免自指递归）。 */
function selfcheckSpec(host: PanelHost): ViewSpec {
  const info = host.hostInfo()
  const panels = host.health()
  const uptime = Date.now() - Date.parse(info.startedAt)
  return {
    blocks: [
      {
        kind: 'metrics',
        title: '宿主自检',
        items: [
          { label: '版本', value: info.version },
          { label: '运行时长', value: `${Math.round(uptime / 60000)} 分钟` },
          { label: '取数超时', value: `${String(info.viewTimeoutMs)}ms` },
          { label: '动作超时', value: `${String(info.actionTimeoutMs)}ms` },
          { label: '贡献面板', value: String(panels.length), tone: panels.length > 0 ? 'ok' : 'warn' },
        ],
      },
      {
        kind: 'table',
        title: '贡献健康（**宿主实测**，不采信贡献方自报——语义文档 §4.5）',
        columns: [
          { key: 'id', label: 'id' },
          { key: 'title', label: '面板' },
          { key: 'health', label: '健康' },
          { key: 'lastDurationMs', label: '最近耗时', align: 'right' },
          { key: 'lastOkAt', label: '最近成功' },
          { key: 'lastError', label: '最近错误' },
        ],
        rows: panels.map((p) => ({
          id: p.id,
          title: p.title,
          health: p.health,
          lastDurationMs: p.lastDurationMs === null ? '—' : `${String(p.lastDurationMs)}ms`,
          lastOkAt: p.lastOkAt ?? '—',
          lastError: p.lastError ?? '—',
        })),
      },
      {
        kind: 'text',
        title: '语义',
        lines: [
          '健康度 = 连续失败次数 + 最近耗时（>1000ms 记 degraded，连续 ≥2 次失败记 down，无样本记 unknown）。',
          '单面板取数失败只让该面板降级，外壳与其他面板不受影响。',
          '触及「删数据 / 动凭据 / 动核心引擎」的动作由宿主拒绝派发（语义文档 §5.4）。',
        ],
      },
    ],
  }
}

// ---------- apply ----------
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-panel')
  if (!config.enabled) return
  const dh = dshHomeOf(config)
  const startedAt = new Date().toISOString()

  const host = new PanelHost(ctx, {
    viewTimeoutMs: config.viewTimeoutMs,
    actionTimeoutMs: config.actionTimeoutMs,
    auditDir: join(dh, 'panel'),
    slowMs: 1000,
    version: VERSION,
    startedAt,
  })

  // 内置面板 #1：插件管理（吃自己的狗粮——它只交声明，不碰路由/HTML）
  const deps: PluginManagerDeps = {
    dshHome: dh,
    profilesDir: profilesDirOf(config),
    selfPluginsDir: selfPluginsDirOf(config),
    defaultProfile: config.defaultProfile,
  }
  ctx.effect(() => host.register(createPluginManagerPanel(deps)), 'dsh-panel: builtin plugin-manager')

  // 内置面板 #2~#4：任务板 / 养成档案 / 分身。
  // 三个都**自包含取数**（直接读 .taskboard / .dsh / .agent-teams 的落盘），
  // 因此不依赖对应插件的运行期实现——面板只看数据，插件缺席也只少一块数据、不崩。
  const workspace = workspaceOf(config)
  ctx.effect(() => host.register(createTaskboardPanel({ workspace })), 'dsh-panel: builtin taskboard')
  ctx.effect(() => host.register(createGrowthProfilePanel({ dshHome: dh, workspace })), 'dsh-panel: builtin growth-profile')
  ctx.effect(() => host.register(createAgentTeamsPanel({ workspace })), 'dsh-panel: builtin agent-teams')

  // ---------- 页面 ----------
  const serveShell = (_req: IncomingMessage, res: ServerResponse): void => {
    const shell = readAsset('shell.html')
    if (shell === undefined) {
      html(res, 500, '<!DOCTYPE html><meta charset="utf-8"><h1>面板外壳缺失</h1><p>缺少 lib/assets/shell.html —— 运行 pnpm build 生成。</p>')
      return
    }
    html(res, 200, shell)
  }
  // 官方 webserver 契约：path 不以 / 结尾；两条都注册以容忍尾斜杠访问
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/panel', handler: serveShell }), 'dsh-panel: /panel')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/panel/', handler: serveShell }), 'dsh-panel: /panel/')

  // ---------- 资产（prefix 路由 + 穿越校验） ----------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/panel/assets',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      const rel = pathname.replace(/^\/panel\/assets\/?/, '')
      const type = MIME[extname(rel)]
      if (rel === '' || type === undefined) { res.writeHead(404); res.end(); return }
      // 穿越校验：目标必须落在资产目录内（Windows 用 sep 判定，参照官方 frontend-static 教训）
      for (const dir of assetDirs()) {
        const target = resolve(normalize(join(dir, rel)))
        if (target !== dir && !target.startsWith(dir + sep)) continue
        if (!existsSync(target)) continue
        try {
          const body = readFileSync(target)
          res.writeHead(200, { 'content-type': type })
          res.end(body)
          return
        } catch { /* 换下一个候选目录 */ }
      }
      res.writeHead(404); res.end()
    },
  }), 'dsh-panel: /panel/assets')

  // ---------- API ----------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/panel/registry',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      try {
        json(res, 200, {
          ok: true,
          host: { version: VERSION, startedAt },
          panels: [
            ...host.list(),
            { id: '__selfcheck', title: '宿主自检', order: 9999, icon: 'shield', description: '宿主与贡献的实测健康', health: 'ok' as const },
          ],
        })
      } catch (e) {
        json(res, 500, { ok: false, error: String(e) })
      }
    },
  }), 'dsh-panel: /api/panel/registry')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/panel/view',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const id = url.searchParams.get('id') ?? ''
        if (id === '__selfcheck') {
          json(res, 200, { ok: true, spec: selfcheckSpec(host), generatedAt: new Date().toISOString(), durationMs: 0, degraded: false, error: null })
          return
        }
        const params: Record<string, string> = {}
        for (const [k, v] of url.searchParams) if (k !== 'id') params[k] = v
        const outcome = await host.view(id, params)
        json(res, 200, outcome)
      } catch (e) {
        json(res, 500, { ok: false, error: String(e), degraded: true, spec: null })
      }
    },
  }), 'dsh-panel: /api/panel/view')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/panel/action',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const body = await readBody(req)
        const outcome = await host.dispatch({
          panelId: String(body.panelId ?? ''),
          actionId: String(body.actionId ?? ''),
          params: body.params as Record<string, unknown> | undefined,
          confirm: body.confirm === true,
        })
        // 审批门命中时，宿主把请示项落到日志（M2 接线任务板/Telegram，见语义文档 §5.4 [待逼近]）
        const hint = (outcome.data as { approvalHint?: string } | undefined)?.approvalHint
        if (hint !== undefined) logger.warn('面板请示（未执行）：' + hint)
        json(res, outcome.ok ? 200 : outcome.status, outcome)
      } catch (e) {
        json(res, 400, { ok: false, error: String(e), status: 400 })
      }
    },
  }), 'dsh-panel: /api/panel/action')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/panel/selfcheck',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      try {
        json(res, 200, {
          ok: true,
          host: { ...host.hostInfo(), uptimeMs: Date.now() - Date.parse(startedAt) },
          panels: host.health(),
        })
      } catch (e) {
        json(res, 500, { ok: false, error: String(e) })
      }
    },
  }), 'dsh-panel: /api/panel/selfcheck')

  logger.info(`ready: 面板宿主 v${VERSION} → http://127.0.0.1:3080/panel/（贡献 ${String(host.list().length)} 个面板）`)
}
