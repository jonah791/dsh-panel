/**
 * panels/plugin-manager.ts — 内置面板 #1：插件管理（宿主吃自己的狗粮）
 *
 * 它是**第一个消费方**：不直接写任何 HTML/路由，只交出一份「视图规格 + 动作表」，
 * 由宿主渲染。原来那一整套自写界面（panel.html）随之退役——这正是宿主存在的意义。
 *
 * 数据源（自包含实现，不依赖 dsh-agent-plugin-manager；官方 plugin-inventory 只读且 Remote-only，
 * 无法承担挂载/启停等写操作）：扫 self-plugins 目录 + 读 profile 的 cordis.patch.yml。
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PanelContribution, ViewSpec } from '../types.ts'

/** 面板依赖的路径与目标 profile。 */
export interface PluginManagerDeps {
  dshHome: string
  profilesDir: string
  selfPluginsDir: string
  defaultProfile: string
}

/** 一个插件的档案（与 dsh-agent-plugin-manager 的 registry 语义对齐）。 */
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
}

/** 读 patch 的 insert 行（轻量文本解析，不引 js-yaml）。 */
function readPatchInserts(patchFile: string): Map<string, { id: string; disabled: boolean; config: Record<string, unknown> }> {
  const out = new Map<string, { id: string; disabled: boolean; config: Record<string, unknown> }>()
  try {
    if (!existsSync(patchFile)) return out
    const lines = readFileSync(patchFile, 'utf8').split(/\r?\n/)
    let inInsert = false
    let curId: string | null = null
    let curName: string | null = null
    let curDisabled = false
    const flush = (): void => {
      if (curId !== null && curName !== null) out.set(curName, { id: curId, disabled: curDisabled, config: {} })
      curId = null; curName = null; curDisabled = false
    }
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('- insert:')) { flush(); inInsert = true; continue }
      if (!inInsert) continue
      const idm = t.match(/^-\s*id:\s*([\w@./-]+)/)
      if (idm?.[1] !== undefined) { flush(); curId = idm[1]; continue }
      const namem = t.match(/^name:\s*([\w@./-]+)/)
      if (namem?.[1] !== undefined) { curName = namem[1]; continue }
      if (/^disabled:\s*true/.test(t)) curDisabled = true
    }
    flush()
  } catch { /* 读失败 → 空表（面板如实显示 0 项，不假装） */ }
  return out
}

/** 递归收集目录下的 js/ts 文件（用于工具名提取）。 */
function collectSources(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) collectSources(full, out)
      else if (entry.endsWith('.js') || entry.endsWith('.ts')) out.push(full)
    } catch { /* 跳过不可读项 */ }
  }
}

/** 目录内最新 mtime（构建态判定用）。 */
function newestMtime(dir: string): number {
  let newest = 0
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      try {
        const st = statSync(full)
        if (st.isDirectory()) walk(full)
        else if (st.mtimeMs > newest) newest = st.mtimeMs
      } catch { /* 跳过 */ }
    }
  }
  walk(dir)
  return newest
}

/** 扫描 self-plugins 目录 → 插件档案（不含挂载态）。 */
export function scanSelf(dir: string): PanelPlugin[] {
  const out: PanelPlugin[] = []
  try {
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const path = join(dir, name)
      try {
        if (!statSync(path).isDirectory()) continue
        const pkgPath = join(path, 'package.json')
        if (!existsSync(pkgPath)) continue
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
        const sources: string[] = []
        for (const base of ['lib', 'src']) {
          const bp = join(path, base)
          if (existsSync(bp)) collectSources(bp, sources)
        }
        const tools: string[] = []
        const toolRe = /defineTool\s*\(\s*\{[\s\S]{0,500}?name:\s*'([a-zA-Z_]\w*)'/g
        for (const file of sources) {
          let text = ''
          try { text = readFileSync(file, 'utf8') } catch { continue }
          let m: RegExpExecArray | null
          while ((m = toolRe.exec(text)) !== null) { if (m[1] !== undefined && !tools.includes(m[1])) tools.push(m[1]) }
        }
        tools.sort()
        const lib = join(path, 'lib')
        const src = join(path, 'src')
        let built = false
        if (existsSync(lib)) built = !existsSync(src) || newestMtime(lib) >= newestMtime(src)
        out.push({
          name,
          version: String(pkg.version ?? ''),
          source: 'self',
          path,
          purpose: String(pkg.description ?? ''),
          tools,
          built,
          status: 'unmounted',
          config: {},
        })
      } catch { /* 单插件损坏跳过 */ }
    }
  } catch { /* 目录不可读 */ }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 对账：self 插件 + patch insert → 完整档案。 */
export function buildState(deps: PluginManagerDeps, profile: string): { plugins: PanelPlugin[]; generatedAt: string } {
  const self = scanSelf(deps.selfPluginsDir)
  const inserts = readPatchInserts(join(deps.profilesDir, profile, 'cordis.patch.yml'))
  const byName = new Map(self.map((p) => [p.name, p] as const))
  const plugins: PanelPlugin[] = []
  const seen = new Set<string>()
  for (const [name, row] of inserts) {
    seen.add(name)
    const selfPlugin = byName.get(name)
    if (selfPlugin !== undefined) {
      selfPlugin.status = row.disabled ? 'disabled' : 'mounted'
      selfPlugin.profile = profile
      plugins.push(selfPlugin)
    } else {
      plugins.push({
        name, version: '', source: name.startsWith('@') ? 'official' : 'unknown', path: null,
        purpose: '（非 self-plugins 插件，来自 profile patch）', tools: [], built: true,
        status: row.disabled ? 'disabled' : 'mounted', profile, config: {},
      })
    }
  }
  for (const p of self) if (!seen.has(p.name)) plugins.push(p)
  return { plugins, generatedAt: new Date().toISOString() }
}

/** 原子写（备份语义由 patch 自身的提交历史承担）。 */
function writeAtomic(file: string, content: string): void {
  const tmp = file + '.panel-tmp'
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** 改 patch 的 disabled 行（无则插入）。 */
export function patchSetDisabled(patchFile: string, name: string, disabled: boolean): { ok: boolean; error?: string } {
  try {
    const lines = readFileSync(patchFile, 'utf8').split(/\r?\n/)
    const nameIdx = lines.findIndex((l) => l.trim() === `name: ${name}`)
    if (nameIdx === -1) return { ok: false, error: `patch 中未找到 name: ${name}` }
    let blockStart = nameIdx
    while (blockStart > 0) {
      const line = lines[blockStart]
      if (line === undefined) break
      if (/^\s*-\s*id:/.test(line)) break
      blockStart -= 1
    }
    let blockEnd = nameIdx
    while (blockEnd < lines.length - 1) {
      const next = lines[blockEnd + 1]
      if (next === undefined) break
      const t = next.trim()
      if ((/^\s*-\s*id:/.test(t) || /^- insert:/.test(t)) && blockEnd + 1 > blockStart) break
      blockEnd += 1
    }
    const block = lines.slice(blockStart, blockEnd + 1)
    const disIdx = block.findIndex((l) => /^\s*disabled:/.test(l.trim()))
    const indent = '        '
    if (disIdx >= 0) lines[blockStart + disIdx] = `${indent}disabled: ${disabled}`
    else {
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

/** 写哨兵（watch 预检后重启生效）。 */
export function writeSentinel(dshHomeDir: string, note: string): void {
  writeFileSync(join(dshHomeDir, '.hot-reload-flag'), JSON.stringify({ workspace: join(dshHomeDir, '..'), note }, null, 2), 'utf8')
}

/** 把档案列表编译成视图规格（宿主的白名单块）。 */
export function toViewSpec(deps: PluginManagerDeps, profile: string): ViewSpec {
  const { plugins, generatedAt } = buildState(deps, profile)
  const mounted = plugins.filter((p) => p.status === 'mounted')
  const disabled = plugins.filter((p) => p.status === 'disabled')
  const unmounted = plugins.filter((p) => p.status === 'unmounted')
  const unbuilt = plugins.filter((p) => !p.built)
  return {
    blocks: [
      {
        kind: 'metrics',
        title: `插件总览 · profile=${profile}`,
        items: [
          { label: '插件总数', value: String(plugins.length) },
          { label: '已挂载', value: String(mounted.length), tone: 'ok' },
          { label: '已禁用', value: String(disabled.length), tone: disabled.length > 0 ? 'warn' : 'muted' },
          { label: '未挂载', value: String(unmounted.length), tone: unmounted.length > 0 ? 'warn' : 'muted' },
          { label: '构建落后', value: String(unbuilt.length), tone: unbuilt.length > 0 ? 'bad' : 'ok', hint: 'lib 早于 src，需重新构建' },
        ],
      },
      {
        kind: 'table',
        title: '插件清单（启用/禁用会改 patch 并写哨兵触发预检重启）',
        columns: [
          { key: 'name', label: '名称' },
          { key: 'status', label: '状态' },
          { key: 'version', label: '版本' },
          { key: 'source', label: '来源' },
          { key: 'toolCount', label: '工具数', align: 'right' },
          { key: 'built', label: '构建' },
          { key: 'purpose', label: '用途' },
        ],
        rows: plugins.map((p) => ({
          name: p.name,
          status: p.status,
          version: p.version || '—',
          source: p.source,
          toolCount: String(p.tools.length),
          built: p.built ? 'ok' : '落后',
          purpose: p.purpose.slice(0, 80),
        })),
        rowActions: ['enable', 'disable', 'reload'],
      },
      { kind: 'text', title: '说明', lines: [
        `快照时刻：${generatedAt}`,
        '启用/禁用只改 profile 的 cordis.patch.yml，随后由哨兵触发守护预检重启生效——面板本身不做任何进程操作。',
      ] },
    ],
  }
}

/**
 * 构造「插件管理」面板贡献。
 * @param deps - 路径与目标 profile
 */
export function createPluginManagerPanel(deps: PluginManagerDeps): PanelContribution {
  return {
    id: 'plugin-manager',
    title: '插件管理',
    order: 10,
    icon: 'plug',
    description: '查看自研插件清单/构建态与挂载态，启停经 patch + 哨兵生效',
    style: { accent: '#f472b6' },
    view: (params) => toViewSpec(deps, params.profile ?? deps.defaultProfile),
    actions: {
      enable: {
        label: '启用', level: 'write',
        params: { name: 'string', profile: 'string' },
        run: (params) => applyToggle(deps, params, false),
      },
      disable: {
        label: '禁用', level: 'write',
        params: { name: 'string', profile: 'string' },
        run: (params) => applyToggle(deps, params, true),
      },
      reload: {
        label: '重启加载', level: 'write',
        run: () => {
          writeSentinel(deps.dshHome, 'panel: 插件管理面板请求重启加载')
          return { ok: true, message: '已写哨兵：守护预检后重启 web 生效', data: { sentinel: '.hot-reload-flag' } }
        },
      },
    },
  }
}

/** 启停动作的共用实现。 */
function applyToggle(deps: PluginManagerDeps, params: Record<string, unknown>, disabled: boolean): { ok: boolean; message: string } {
  const name = typeof params.name === 'string' ? params.name : ''
  const profile = typeof params.profile === 'string' && params.profile !== '' ? params.profile : deps.defaultProfile
  if (name === '') return { ok: false, message: 'name 必填' }
  if (name === 'dsh-panel') return { ok: false, message: '不允许面板禁用自己（会造成面板失联）' }
  const patchFile = join(deps.profilesDir, profile, 'cordis.patch.yml')
  const result = patchSetDisabled(patchFile, name, disabled)
  if (!result.ok) return { ok: false, message: result.error ?? 'patch 修改失败' }
  writeSentinel(deps.dshHome, `panel: ${disabled ? '禁用' : '启用'} ${name} @ ${profile}`)
  return { ok: true, message: `已${disabled ? '禁用' : '启用'} ${name}（${profile}）——已写哨兵，预检通过后重启生效` }
}
