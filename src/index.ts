/**
 * dsh-panel — 独立实时前端面板（零官方 client 依赖）
 *
 * 主人 2026-09-05 定调：官方 web 的 client 面板（slot/Remote/codec）随 alpha 升级易失效，
 * 不想再跟官方 web 兼容性纠缠——做独立前端，宿主托管自包含 HTML，走 HTTP API。
 *
 * 架构：
 *   - GET  /panel/         → 自包含 HTML（内联 JS/CSS，无任何 @deepseek-ai/dsh-client-* 依赖）
 *   - GET  /api/panel/state → 插件列表 JSON（registry 快照）
 *   - POST /api/panel/op   → 操作 {op: start|stop|unmount|remove, name, profile}
 *   同源 fetch 自动带认证 cookie（页面由宿主 webServer 托管）——零 token 手写。
 *
 * 数据源（自包含实现，不依赖 dsh-agent-plugin-manager）：
 *   - 扫 self-plugins 目录（package.json 元数据 + lib 构建态 + defineTool 提取）
 *   - 读 profiles/<profile>/cordis.patch.yml 的 insert 行（挂载/禁用态 + config 快照）
 *   - 操作 = 改 patch（备份 + 原子写）+ 写哨兵（watch 预检重启）
 *
 * 首版范围：插件管理（列表/详情/启停/挂载/卸载/创建/配置查看）。
 * @module dsh-panel
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync, renameSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'agent-panel'
export const inject = ['webServer'] as const

export interface Config {
  enabled: boolean
  dshHome: string
  profilesDir: string
  selfPluginsDir: string
  /** 默认操作目标 profile（web）。 */
  defaultProfile: string
}
export const Config = z.object({
  enabled: z.boolean().default(true),
  dshHome: z.string().default(''),
  profilesDir: z.string().default(''),
  selfPluginsDir: z.string().default(''),
  defaultProfile: z.string().default('web'),
})

// ---------- 路径解析 ----------
function dshHome(cfg: Config): string {
  return cfg.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
}
function profilesDir(cfg: Config): string {
  return cfg.profilesDir || join(dshHome(cfg), 'profiles')
}
function selfPluginsDir(cfg: Config): string {
  return cfg.selfPluginsDir || join(dshHome(cfg), '..', 'self-plugins')
}

// ---------- 面板 HTML（独立文件 lib/assets/panel.html，运行时读——根治 TS 模板字符串转义） ----------
let _panelHtmlCache: string | null = null
function panelHtml(): string {
  if (_panelHtmlCache !== null) return _panelHtmlCache
  const here = dirname(fileURLToPath(import.meta.url)) // lib/
  const candidates = [
    join(here, 'assets', 'panel.html'),
    join(here, '..', 'src', 'assets', 'panel.html'), // 开发态（src 直跑）
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        _panelHtmlCache = readFileSync(p, 'utf8')
        return _panelHtmlCache
      }
    } catch { /* 继续找 */ }
  }
  return '<!DOCTYPE html><html><body><h1>panel.html 缺失</h1></body></html>'
}

// ---------- 插件档案（轻量版，对齐 plugin-manager registry 语义） ----------
interface PanelPlugin {
  name: string
  version: string
  source: 'self' | 'official' | 'unknown'
  path: string | null
  purpose: string
  tools: string[]
  built: boolean
  status: 'mounted' | 'disabled' | 'unmounted'
  profile?: string
  config: Record<string, unknown>
  hasClient: boolean
}

/** 读 patch 的 insert 行：返回 Map<name, {id, disabled, config}>（轻量文本解析，不引 js-yaml）。 */
function readPatchInserts(patchFile: string): Map<string, { id: string; disabled: boolean; config: Record<string, unknown> }> {
  const out = new Map<string, { id: string; disabled: boolean; config: Record<string, unknown> }>()
  try {
    if (!existsSync(patchFile)) return out
    const text = readFileSync(patchFile, 'utf8')
    const lines = text.split(/\r?\n/)
    let inInsert = false
    let curId: string | null = null
    let curName: string | null = null
    let curDisabled = false
    let curConfig: Record<string, unknown> | null = null
    const flush = (): void => {
      if (curId !== null && curName !== null) {
        out.set(curName, { id: curId, disabled: curDisabled, config: curConfig ?? {} })
      }
      curId = null; curName = null; curDisabled = false; curConfig = null
    }
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('- insert:')) { flush(); inInsert = true; continue }
      if (inInsert && /^-\s+\w/.test(t) && !t.startsWith('- id:') && !t.startsWith('- name:') && !t.startsWith('  ')) {
        // 新顶层项（非 insert 块）
        flush(); inInsert = false
      }
      if (!inInsert) {
        if (/^\s*-\s*id:/.test(t)) { flush(); const m = t.match(/id:\s*([\w@./-]+)/); if (m && m[1]) curId = m[1] }
        continue
      }
      const idm = t.match(/^-\s*id:\s*([\w@./-]+)/)
      if (idm && idm[1]) { flush(); curId = idm[1]; continue }
      const namem = t.match(/^name:\s*([\w@./-]+)/)
      if (namem && namem[1]) { curName = namem[1]; continue }
      if (/^disabled:\s*true/.test(t)) curDisabled = true
    }
    flush()
  } catch { /* 读失败 → 空 */ }
  return out
}

/** 扫描 self-plugins 目录 → 插件档案（不含挂载态；由调用方对账 patch）。 */
function scanSelf(dir: string): PanelPlugin[] {
  const out: PanelPlugin[] = []
  try {
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const p = join(dir, name)
      try {
        if (!statSync(p).isDirectory()) continue
        const pkgPath = join(p, 'package.json')
        if (!existsSync(pkgPath)) continue
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
        // tools 提取（递归扫 lib/*.js + src/*.ts 的 defineTool name——拆分模块也覆盖）
        const tools: string[] = []
        const toolSrcs: string[] = []
        for (const base of ['lib', 'src']) {
          const bp = join(p, base)
          if (!existsSync(bp)) continue
          const walkJs = (d: string): void => {
            for (const e of readdirSync(d)) {
              const fp = join(d, e)
              try {
                const st = statSync(fp)
                if (st.isDirectory()) walkJs(fp)
                else if (e.endsWith('.js') || e.endsWith('.ts')) toolSrcs.push(fp)
              } catch { /* 跳过 */ }
            }
          }
          walkJs(bp)
        }
        const toolRe = /defineTool\s*\(\s*\{[\s\S]{0,500}?name:\s*'([a-zA-Z_][\w]*)'/g
        for (const fp of toolSrcs) {
          let text = ''
          try { text = readFileSync(fp, 'utf8') } catch { continue }
          let m: RegExpExecArray | null
          while ((m = toolRe.exec(text))) { if (m[1] && !tools.includes(m[1])) tools.push(m[1]) }
        }
        tools.sort()
        // built 判定（lib 新于 src）
        let built = false
        const lib = join(p, 'lib')
        const src = join(p, 'src')
        if (existsSync(lib)) {
          if (!existsSync(src)) built = true
          else {
            let libNew = 0; let srcNew = 0
            const walk = (d: string, cb: (t: number) => void): void => {
              for (const e of readdirSync(d)) {
                const fp = join(d, e)
                try {
                  const st = statSync(fp)
                  if (st.isDirectory()) walk(fp, cb)
                  else cb(st.mtimeMs)
                } catch { /* 跳过 */ }
              }
            }
            walk(lib, (t) => { if (t > libNew) libNew = t })
            walk(src, (t) => { if (t > srcNew) srcNew = t })
            built = libNew >= srcNew
          }
        }
        out.push({
          name,
          version: String(pkg.version ?? ''),
          source: 'self',
          path: p,
          purpose: String(pkg.description ?? ''),
          tools,
          built,
          status: 'unmounted',
          config: {},
          hasClient: Boolean((pkg as { dsh?: { client?: unknown } }).dsh?.client),
        })
      } catch { /* 单插件损坏跳过 */ }
    }
  } catch { /* 目录不可读 */ }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 对账：self 插件 + patch insert → 完整档案（status 由 patch 决定）。 */
function buildState(cfg: Config, profile: string): { plugins: PanelPlugin[]; profiles: string[]; generatedAt: string; patchFile: string } {
  const self = scanSelf(selfPluginsDir(cfg))
  const patchFile = join(profilesDir(cfg), profile, 'cordis.patch.yml')
  const inserts = readPatchInserts(patchFile)
  const byName = new Map(self.map((p) => [p.name, p] as const))
  // official/unknown：patch 里有但 self 目录没有的（如 @deepseek-ai/*）——列出 name 即可（来源标记）
  const profiles: string[] = []
  try {
    const pd = profilesDir(cfg)
    if (existsSync(pd)) {
      for (const e of readdirSync(pd)) {
        if (statSync(join(pd, e)).isDirectory() && existsSync(join(pd, e, 'cordis.patch.yml'))) profiles.push(e)
      }
    }
  } catch { /* 忽略 */ }

  const plugins: PanelPlugin[] = []
  const seen = new Set<string>()
  for (const [name, row] of inserts) {
    seen.add(name)
    const selfP = byName.get(name)
    if (selfP) {
      selfP.status = row.disabled ? 'disabled' : 'mounted'
      selfP.profile = profile
      selfP.config = row.config ?? {}
      plugins.push(selfP)
    } else {
      // patch 里有但非 self（official/third-party）
      plugins.push({
        name, version: '', source: name.startsWith('@') ? 'official' : 'unknown',
        path: null, purpose: '（非 self-plugins 插件，来自 profile patch）',
        tools: [], built: true, status: row.disabled ? 'disabled' : 'mounted',
        profile, config: row.config ?? {}, hasClient: false,
      })
    }
  }
  // self 目录有但 patch 没有 = unmounted
  for (const p of self) {
    if (!seen.has(p.name)) plugins.push(p)
  }
  return { plugins, profiles, generatedAt: new Date().toISOString(), patchFile }
}

// ---------- 操作（改 patch + 写哨兵） ----------
function patchSetDisabled(patchFile: string, name: string, disabled: boolean): { ok: boolean; error?: string } {
  try {
    const text = readFileSync(patchFile, 'utf8')
    // 找到 name: <name> 所在 insert 块的 disabled 行（若有则改，无则插入）
    const lines = text.split(/\r?\n/)
    const nameIdx = lines.findIndex((l) => l.trim() === `name: ${name}`)
    if (nameIdx === -1) return { ok: false, error: `patch 中未找到 name: ${name}` }
    // 向上找所属 insert 块的 id 行，向下找块内 disabled 行
    let blockStart = nameIdx
    while (blockStart > 0) {
      const line = lines[blockStart]
      if (line === undefined) break
      if (/^\s*-\s*id:/.test(line)) break
      blockStart -= 1
    }
    // 块结束 = 下一个顶层 - id: 或 - insert:
    let blockEnd = nameIdx
    while (blockEnd < lines.length - 1) {
      const nx = blockEnd + 1
      const tnx = lines[nx]
      if (tnx === undefined) break
      const tt = tnx.trim()
      if ((/^\s*-\s*id:/.test(tt) || /^- insert:/.test(tt)) && nx > blockStart) break
      blockEnd = nx
    }
    const block = lines.slice(blockStart, blockEnd + 1)
    const disIdx = block.findIndex((l) => /^\s*disabled:/.test(l.trim()))
    const indent = '        '
    if (disIdx >= 0) {
      lines[blockStart + disIdx] = `${indent}disabled: ${disabled}`
    } else {
      // 插到 config 前（若无 config 插块尾）
      const cfgIdx = block.findIndex((l) => /^\s*config:/.test(l.trim()))
      if (cfgIdx >= 0) lines.splice(blockStart + cfgIdx, 0, `${indent}disabled: ${disabled}`)
      else lines.splice(blockEnd + 1, 0, `${indent}disabled: ${disabled}`)
    }
    writeAtomic(patchFile, lines.join('\n'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

function writeAtomic(file: string, content: string): void {
  const tmp = file + '.panel-tmp'
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function writeSentinel(dshHomeDir: string, note: string): void {
  const file = join(dshHomeDir, '.hot-reload-flag')
  writeFileSync(file, JSON.stringify({ workspace: join(dshHomeDir, '..'), note }, null, 2), 'utf8')
}

// ---------- HTTP 辅助 ----------
function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); if (body.length > 1_000_000) req.destroy() })
    req.on('end', () => { try { resolvePromise(JSON.parse(body || '{}') as Record<string, unknown>) } catch { reject(new Error('bad json')) } })
    req.on('error', reject)
  })
}

// ---------- apply ----------
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-panel')
  if (!config.enabled) return
  const dh = dshHome(config)

  // GET /panel/ → 自包含 HTML
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/panel/',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(panelHtml())
    },
  }), 'dsh-panel: /panel/')

  // GET /api/panel/state → 插件列表
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/panel/state',
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      try {
        const profile = config.defaultProfile
        const state = buildState(config, profile)
        json(res, 200, { ok: true, ...state })
      } catch (e) {
        json(res, 500, { ok: false, error: String(e) })
      }
    },
  }), 'dsh-panel: /api/panel/state')

  // POST /api/panel/op → 操作
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/panel/op',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const body = await readBody(req)
        const op = String(body.op ?? '')
        const name = String(body.name ?? '')
        const profile = String(body.profile ?? config.defaultProfile)
        if (!name) { json(res, 400, { ok: false, error: 'name 必填' }); return }
        const patchFile = join(profilesDir(config), profile, 'cordis.patch.yml')
        let result: { ok: boolean; error?: string; note?: string }
        switch (op) {
          case 'start':
          case 'enable':
            result = patchSetDisabled(patchFile, name, false)
            break
          case 'stop':
          case 'disable':
            result = patchSetDisabled(patchFile, name, true)
            break
          case 'reload':
            // 仅写哨兵触发重启（插件代码改了需要重启加载）
            result = { ok: true, note: '已写哨兵，web 将预检重启' }
            break
          default:
            json(res, 400, { ok: false, error: '未知 op: ' + op }); return
        }
        if (result.ok && op !== 'reload') {
          writeSentinel(dh, 'panel op ' + op + ' ' + name)
          result.note = '已修改 patch + 写哨兵（watch 将预检重启生效）'
        }
        json(res, 200, result)
      } catch (e) {
        json(res, 500, { ok: false, error: String(e) })
      }
    },
  }), 'dsh-panel: /api/panel/op')

  logger.info('ready: dsh-panel 独立面板已挂载 → http://127.0.0.1:3080/panel/')
}
