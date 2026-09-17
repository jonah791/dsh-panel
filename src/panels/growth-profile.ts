/**
 * panels/growth-profile.ts — 内置面板：养成档案
 *
 * 数据源（**全部只读**，零采集、零自动触发——被动哲学）：
 *   - `<dshHome>/life-core/state.json` —— status/todayTurns/cycleMinutes/lastActiveAt/lastSelfTurnAt/self{role,relation,creed,concerns,values}/bornAt
 *   - `<dshHome>/storages/agent_memory.json` —— `tables.entries`，统计条目数与 kind 分布（fact/knowledge/episodic/summary）与归档数
 *   - `<dshHome>/checkpoints/*` —— 周目存档目录数 + 最近一个（读 `manifest.json` 的 createdAt/reason）
 *   - `<workspace>/AGENTS.md` —— 灵魂版本行（`Alice's Soul · 版本 x.y · 日期`）
 *   - `<workspace>/self-plugins/*` 与技能目录（`<dshHome>/skills`、`~/.agents/skills`、`<workspace>/.dsh/skills`、`<workspace>/.agents/skills`）——规模
 *
 * 取数口径参照 `self-plugins/dsh-growth-profile/src/index.ts`（同一落盘、同一字段名），
 * 但本面板**自包含**且**只读**：不依赖那个插件的运行期实现，也不写任何文件。
 * 面板纪律（docs/semantic.md §4.2/§4.3）：只交声明——视图规格，无动作。
 * @module dsh-panel/panels/growth-profile
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PanelContribution, ViewSpec } from '../types.ts'

/** 面板依赖：DSH_HOME 与工作区根。 */
export interface GrowthProfileDeps {
  /** DSH_HOME（如 E:/alice/.dsh）——life-core / storages / checkpoints 都在其下。 */
  dshHome: string
  /** 工作区根（如 E:/alice）——AGENTS.md 与 self-plugins 在其下。 */
  workspace: string
}

/** life-core 自我模型投影（只取展示所需字段）。 */
interface SelfModel {
  role?: string
  relation?: string
  creed?: string
  concerns?: string[]
  values?: Record<string, number>
}

/** life-core 状态文件投影。 */
interface LifeState {
  status?: string
  todayTurns?: number
  cycleMinutes?: number
  bornAt?: string
  lastActiveAt?: string
  lastSelfTurnAt?: string
  lastScheduledDueAt?: string
  self?: SelfModel
}

/** 记忆条目投影。 */
interface MemoryEntry {
  kind?: string
  title?: string
  tags?: string[]
  updatedAt?: string
  createdAt?: string
  archived?: boolean
}

/** 周目存档投影。 */
export interface CheckpointSummary {
  id: string
  /** 目录名解出的本地时刻（`YYYY-MM-DD HH:MM:SS`）。 */
  at: string
  createdAt: string
  reason: string
}

/** 读 JSON（缺失/损坏 → undefined，只读路径永不抛错）。 */
function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** 截断长文本（面板是给人扫的）。 */
function clip(text: string | undefined, max: number): string {
  const value = (text ?? '').trim().replace(/\s+/g, ' ')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** 时间戳 → 人读短格式。 */
function shortDate(value: string | undefined): string {
  if (value === undefined || value === '') return '—'
  return value.slice(0, 16).replace('T', ' ')
}

/** 目录名 `YYYYMMDD-HHMMSS-<hash>` → `YYYY-MM-DD HH:MM:SS`。 */
function dirNameToStamp(name: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name)
  if (m === null) return name
  return `${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''} ${m[4] ?? ''}:${m[5] ?? ''}:${m[6] ?? ''}`
}

/** 列周目存档（按时刻降序）。 */
export function listCheckpoints(dshHome: string): CheckpointSummary[] {
  const root = join(dshHome, 'checkpoints')
  const out: CheckpointSummary[] = []
  try {
    if (!existsSync(root)) return out
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch { continue }
      const manifest = readJson<{ createdAt?: string; reason?: string }>(join(dir, 'manifest.json'))
      out.push({
        id: name,
        at: dirNameToStamp(name),
        createdAt: manifest?.createdAt ?? '',
        reason: manifest?.reason ?? '',
      })
    }
  } catch { /* 目录不可读 → 空列表 */ }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** 读记忆条目（`tables.entries` 的值集合）。 */
export function readMemoryEntries(dshHome: string): MemoryEntry[] {
  const parsed = readJson<{ tables?: { entries?: Record<string, MemoryEntry> } }>(join(dshHome, 'storages', 'agent_memory.json'))
  const entries = parsed?.tables?.entries
  if (entries === undefined || entries === null) return []
  return Object.values(entries).filter((e): e is MemoryEntry => e !== null && typeof e === 'object')
}

/** 统计技能目录（含 SKILL.md 的子目录数）。 */
export interface AssetsSnapshot {
  generatedAt?: string
  chains?: Array<{ chain?: string; address?: string; native?: { symbol?: string; amount?: string }; usdc?: string; status?: string; note?: string }>
  accounts?: Array<{ site?: string; username?: string; fields?: string[] }>
  domains?: Array<{ name?: string; status?: string; plan?: string }>
  code?: { plugins?: number; skills?: number; checkpoints?: number; memoryEntries?: number }
  totals?: { usdcUsd?: string; note?: string }
  notes?: string[]
}

/**
 * 数字资产快照（侧车产物，由 `dsh-growth-profile` 插件写出到 `<dshHome>/growth-profile-assets.json`）。
 * 单一真源纪律（AGENTS.md §5.22 规则 4）：本面板**不做**链上/vault/域名取数——只读快照，
 * 否则同一事实会长出两套判据。快照缺失时如实说明，不伪装成 0。
 */
export function readAssetsSnapshot(dshHome: string): AssetsSnapshot | undefined {
  return readJson<AssetsSnapshot>(join(dshHome, 'growth-profile-assets.json'))
}

export function countSkills(deps: GrowthProfileDeps): { total: number; roots: string[] } {
  const roots = [
    join(deps.dshHome, 'skills'),
    join(homedir(), '.agents', 'skills'),
    join(deps.workspace, '.dsh', 'skills'),
    join(deps.workspace, '.agents', 'skills'),
  ]
  let total = 0
  const hit: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let n = 0
    try {
      for (const name of readdirSync(root)) {
        if (existsSync(join(root, name, 'SKILL.md'))) n += 1
      }
    } catch { /* 单根不可读 → 跳过 */ }
    if (n > 0) hit.push(`${root.replace(/\\/g, '/')}（${String(n)}）`)
    total += n
  }
  return { total, roots: hit }
}

/** 统计自研插件（`<workspace>/self-plugins/*` 含 package.json 的目录）。 */
export function countPlugins(workspace: string): number {
  const root = join(workspace, 'self-plugins')
  if (!existsSync(root)) return 0
  let n = 0
  try {
    for (const name of readdirSync(root)) {
      if (name.startsWith('.')) continue
      if (existsSync(join(root, name, 'package.json'))) n += 1
    }
  } catch { /* 目录不可读 → 0 */ }
  return n
}

/** 提取 AGENTS.md 的灵魂版本行（`版本 x.y` 首次命中）。 */
export function readSoulVersion(workspace: string): { version: string; line: string } {
  const file = join(workspace, 'AGENTS.md')
  if (!existsSync(file)) return { version: '—', line: `AGENTS.md 未找到：${file}` }
  try {
    const text = readFileSync(file, 'utf8')
    const line = text.split(/\r?\n/).find((l) => /版本\s*\d/.test(l)) ?? ''
    const m = /版本\s*([\d.]+)/.exec(line)
    return { version: m?.[1] ?? '—', line: line.trim() }
  } catch (e) {
    return { version: '—', line: `AGENTS.md 读取失败：${String(e)}` }
  }
}

/** 存在天数（bornAt → 现在）。 */
function bornDays(bornAt: string | undefined): number | undefined {
  if (bornAt === undefined || bornAt === '') return undefined
  const ms = new Date(bornAt).getTime()
  if (Number.isNaN(ms)) return undefined
  return Math.max(1, Math.floor((Date.now() - ms) / 86_400_000))
}

/**
 * 把养成档案编译成视图规格。
 * @param deps - DSH_HOME 与工作区根
 * @returns 视图规格（宿主白名单块）
 */
export function toGrowthSpec(deps: GrowthProfileDeps): ViewSpec {
  const state = readJson<LifeState>(join(deps.dshHome, 'life-core', 'state.json'))
  const entries = readMemoryEntries(deps.dshHome)
  const byKind = new Map<string, number>()
  let archived = 0
  for (const e of entries) {
    const kind = e.kind ?? 'unknown'
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
    if (e.archived === true) archived += 1
  }
  const checkpoints = listCheckpoints(deps.dshHome)
  const skills = countSkills(deps)
  const plugins = countPlugins(deps.workspace)
  const soul = readSoulVersion(deps.workspace)
  const days = bornDays(state?.bornAt)
  const self = state?.self
  const assets = readAssetsSnapshot(deps.dshHome)

  // ---- 里程碑（记忆库 tags 含 milestone）→ 与最近存档合并成一条时间线 ----
  const milestones = entries
    .filter((e) => Array.isArray(e.tags) && e.tags.includes('milestone'))
    .map((e) => ({ at: (e.updatedAt ?? e.createdAt ?? '').slice(0, 16).replace('T', ' '), title: clip(e.title, 110) }))
    .filter((m) => m.at !== '')
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, 5)

  const events = [
    ...checkpoints.slice(0, 6).map((c) => ({
      at: c.at,
      title: `周目存档 · ${c.id}`,
      detail: c.reason === '' ? '（manifest 无 reason）' : clip(c.reason, 160),
      tone: 'ok' as const,
    })),
    ...milestones.map((m) => ({ at: m.at, title: `里程碑 · ${m.title}`, detail: undefined, tone: 'warn' as const })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  const lines: string[] = [
    `灵魂版本：${soul.version}（${clip(soul.line, 80)}）`,
    `技能库：${String(skills.total)} 项`,
    ...skills.roots.map((r) => `  · ${r}`),
    `自研插件：${String(plugins)} 个（${join(deps.workspace, 'self-plugins').replace(/\\/g, '/')}）`,
    `记忆条目：${String(entries.length)} 条 · 归档 ${String(archived)} 条`,
    '数据源：life-core 状态 + 记忆库 + checkpoints + AGENTS.md + self-plugins/技能目录；全部只读，零采集、零自动触发。',
  ]
  if (state === undefined) lines.unshift(`⚠ 未读到 life-core 状态（${join(deps.dshHome, 'life-core', 'state.json').replace(/\\/g, '/')}）——面板照常可用`)

  const blocks: ViewSpec['blocks'] = [
    {
      kind: 'metrics',
      title: '养成档案 · 总览',
      items: [
        { label: '记忆条目', value: String(entries.length) },
        { label: '已归档', value: String(archived), tone: 'muted' },
        { label: '技能', value: String(skills.total), tone: skills.total > 0 ? 'ok' : 'warn' },
        { label: '自研插件', value: String(plugins) },
        { label: '周目存档', value: String(checkpoints.length) },
        { label: '存在', value: days === undefined ? '—' : `${String(days)} 天` },
      ],
    },
    {
      kind: 'kv',
      title: '自我模型（此刻的我）',
      pairs: [
        { key: '状态', value: `${state?.status ?? '—'} · 今日 ${String(state?.todayTurns ?? 0)} 圈 · 周期 ${String(state?.cycleMinutes ?? 0)}min` },
        { key: '角色', value: self?.role ?? '—' },
        { key: '关系', value: self?.relation ?? '—' },
        { key: '宣言', value: self?.creed ?? '—' },
        { key: '价值权重', value: Object.entries(self?.values ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(' / ') || '—' },
        { key: '牵挂', value: (self?.concerns ?? []).length > 0 ? (self?.concerns ?? []).join(' / ') : '无特别牵挂' },
        { key: '最近在场', value: shortDate(state?.lastActiveAt) },
        { key: '最近自我感知圈', value: shortDate(state?.lastSelfTurnAt) },
        { key: '出生', value: shortDate(state?.bornAt) },
        { key: '记忆构成', value: [...byKind.entries()].map(([k, v]) => `${k} ${String(v)}`).join(' / ') || '—' },
      ],
    },
  ]

  // ---- 数字资产（v0.4：只读侧车快照，由 growth_profile 工具刷新） ----
  if (assets === undefined) {
    blocks.push({
      kind: 'text',
      title: '数字资产',
      lines: ['尚无资产快照 —— 调用一次 `growth_profile` 工具即可生成（面板不自行取数，避免两处口径漂移）'],
    })
  } else {
    const chains = assets.chains ?? []
    const accounts = assets.accounts ?? []
    const domains = assets.domains ?? []
    const codes = assets.code ?? {}
    const usdc = assets.totals?.usdcUsd ?? '—'
    if (chains.length + accounts.length + domains.length > 0) {
      blocks.push({
        kind: 'metrics',
        title: '数字资产 · 总览（快照）',
        items: [
          { label: 'USDC 折算', value: `$${usdc}`, hint: '只折算 stablecoin；原生币显示原量，不臆断估值', tone: Number(usdc) > 0 ? 'ok' : 'muted' },
          { label: '链上地址', value: String(chains.length), hint: chains.map((c) => c.chain ?? '').filter(Boolean).join(' / ') },
          { label: '账号（vault）', value: String(accounts.length), hint: '只列非密元数据' },
          { label: '域名', value: String(domains.length) },
          { label: '代码资产', value: `${String(codes.plugins ?? 0)} 插件 / ${String(codes.skills ?? 0)} 技能`, hint: `checkpoint ${String(codes.checkpoints ?? 0)} · 记忆 ${String(codes.memoryEntries ?? 0)}` },
        ],
      })
    }
    if (chains.length > 0) {
      blocks.push({
        kind: 'table',
        title: '链上余额（只读快照）',
        columns: [
          { key: 'chain', label: '链' },
          { key: 'address', label: '地址' },
          { key: 'amount', label: '原生', align: 'right' },
          { key: 'usdc', label: 'USDC', align: 'right' },
          { key: 'status', label: '状态' },
        ],
        rows: chains.map((c) => ({
          chain: c.chain ?? '—',
          address: clip(c.address, 16),
          amount: `${c.native?.amount ?? '—'} ${c.native?.symbol ?? ''}`.trim(),
          usdc: c.usdc ?? '—',
          status: c.status === 'ok' ? 'ok' : `error: ${clip(c.note, 40)}`,
        })),
      })
    }
    if (accounts.length > 0) {
      blocks.push({
        kind: 'table',
        title: `账号清单（${String(accounts.length)} 个 · vault 元数据，无密值）`,
        columns: [
          { key: 'site', label: '站点' },
          { key: 'username', label: '账号' },
          { key: 'fields', label: '凭据字段' },
        ],
        rows: accounts.map((a) => ({ site: a.site ?? '—', username: clip(a.username, 36), fields: (a.fields ?? []).join(',') })),
      })
    }
    if (domains.length > 0) {
      blocks.push({
        kind: 'table',
        title: '域名',
        columns: [
          { key: 'name', label: '域名' },
          { key: 'status', label: '状态' },
          { key: 'plan', label: '方案' },
        ],
        rows: domains.map((d) => ({ name: d.name ?? '—', status: d.status ?? '—', plan: d.plan ?? '—' })),
      })
    }
    const assetNotes = assets.notes ?? []
    if (assetNotes.length > 0) {
      blocks.push({ kind: 'text', title: '资产盘点降级说明（取数失败不伪装成 0）', lines: assetNotes.map((n) => clip(n, 160)) })
    }
    blocks.push({
      kind: 'text',
      title: '资产快照',
      lines: [`快照时间：${shortDate(assets.generatedAt)}（由 growth_profile 工具刷新；面板只读，不自行取数）`],
    })
  }

  if (events.length > 0) {
    blocks.push({ kind: 'timeline', title: '周目与里程碑', events })
  }

  blocks.push({
    kind: 'table',
    title: `周目存档（${String(checkpoints.length)} 个）`,
    columns: [
      { key: 'at', label: '时刻' },
      { key: 'id', label: 'id' },
      { key: 'reason', label: '存档原因' },
    ],
    rows: checkpoints.slice(0, 12).map((c) => ({
      at: c.at,
      id: c.id,
      reason: c.reason === '' ? '—' : clip(c.reason, 90),
    })),
  })

  blocks.push({ kind: 'text', title: '技能与插件规模', lines })
  return { blocks }
}

/**
 * 构造「养成档案」面板贡献（只读，无动作）。
 * @param deps - DSH_HOME 与工作区根
 * @returns 面板贡献
 */
export function createGrowthProfilePanel(deps: GrowthProfileDeps): PanelContribution {
  return {
    id: 'growth-profile',
    title: '养成档案',
    order: 30,
    icon: 'seed',
    description: '自我模型 + 记忆规模 + 周目存档 + 技能/插件规模 + 灵魂版本（只读，被动哲学）',
    style: { accent: '#34d399' },
    view: () => toGrowthSpec(deps),
  }
}
