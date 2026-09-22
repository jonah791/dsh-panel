/**
 * panels/tavern.ts — 内置面板：酒馆「色欲之罪」项目状态（只读）
 *
 * **为什么存在**：`tavern/` 是主人的创作资产（SillyTavern 预设「色欲之罪」V3.4 + 素材/文风/剧本素材），
 * 而它的状态此前只能靠一次次 `ls` 去看——「现在最新的是哪一版」「交接文档还在不在」「资产有多少」
 * 这类问题每次都要重新取证。本面板把**只读取证**固化成一度可看的一页，同时给 §4.7 的
 * 「插件自带前端」通路再加一个正样本（view + frontend + handle 三个面都给）。
 *
 * **硬约束（最高优先级）**：只读取证，**绝不写 `tavern/` 下的任何文件**。
 * 本模块只做 `existsSync` / `readdirSync` / `statSync` 三种只读系统调用，
 * 不 `open` 写、不 `mkdir`、不 `rename`、不 `unlink`，也不 `spawn` 任何进程。
 *
 * **绝不执行脚本**：`dsh-dream-tavern/scripts/` 里的 `.mjs` / `.sh`（含 python 类工具）只被
 * `stat` 列出**存在性与新鲜度**——面板不运行它们（执行是主体决策，不是面板的副作用）。
 *
 * **失败要响亮**：数据源根缺席 ⇒ `collectTavernState()` 抛错 ⇒ `handle` 回 503；
 * 单条目读取失败 ⇒ 记进 `notes` 里的错误行并照实显示，**绝不静默当 0**。
 *
 * @module dsh-panel/panels/tavern
 */
import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PanelContribution, PanelHttpRequest, PanelHttpResponse, Tone, ViewSpec } from '../types.ts'

/** 面板依赖：两个**只读**数据源根。 */
export interface TavernDeps {
  /** 酒馆项目根（`<workspace>/tavern`）——主人的创作资产，本面板只读。 */
  tavernDir: string
  /** 同名插件根（`<selfPluginsDir>/dsh-dream-tavern`）——只读（只看 `scripts/` 的存在性与新鲜度）。 */
  dreamTavernDir: string
}

/**
 * 资产目录清单（相对 `tavernDir` 的**固定常量**）。
 *
 * 固定是安全属性，不是偷懒：面板从不接受任何来自请求的路径片段参与拼接，
 * 因此反代面**不存在**路径穿越的输入面（对比 §5.1 的 assets 穿越校验——那里有输入，这里没有）。
 */
export const ASSET_DIRS: readonly string[] = ['素材', '文风', '剧本素材']

/** 预设产物 = 项目根下的一层 `*.json`（SillyTavern 预设导出物）。 */
const PRESET_SUFFIX = '.json'

/**
 * 文件名版本段的**唯一真源**（解析与家族切分共用同一份正则，避免两处口径漂移）：
 *   - 组 1 = 版本号（`V3.4` → `3.4`）；
 *   - 组 2 = 紧随其后的日期/序号后缀（`V4-0902` 的 `-0902`）——它属于**同一段命名**，切家族时要一起摘掉。
 */
const VERSION_RE = /V(\d+(?:\.\d+)*)((?:[-_ ]\d+)*)/i

/** 交接文档文件名（固定）。 */
const HANDOVER_NAME = '交接文档.md'

/** 「新鲜度」阈值（天）：超过即标 stale——阈值写成常量，避免它变成一个说不清的口径。 */
export const STALE_DAYS = 7

/** 目录递归护栏：超过该深度即停止深入并如实记错（防深层目录把一次取数拖成爬树）。 */
const MAX_DEPTH = 16

/** 一个文件的只读快照。 */
export interface FileEntry {
  /** 文件名（不含目录）。 */
  name: string
  /** 字节数。 */
  bytes: number
  /** 修改时刻（ISO 8601，UTC）。 */
  mtime: string
}

/** 预设产物条目：文件快照 + 文件名里解析出的版本号。 */
export interface PresetArtifact extends FileEntry {
  /** 文件名里的版本号（`色欲之罪V3.4.json` → `3.4`）；文件名里没有 `V<数字>` ⇒ `null`（不假装是 0）。 */
  version: string | null
}

/** 目录计数结果。 */
export interface DirCount {
  /** 目录名（相对酒馆项目根）。 */
  name: string
  /** 绝对路径。 */
  path: string
  /** 目录是否存在（缺席 = 如实说缺席，不是 0 个文件）。 */
  exists: boolean
  /** 文件数（递归，只数真文件；符号链接不跟随）。 */
  files: number
  /** 字节数合计（同一批文件）。 */
  bytes: number
  /** 读取期间的具体错误（空 = 无错）。 */
  errors: string[]
}

/** 一个「文档类」目标的只读状态。 */
export interface DocState {
  /** 文件名。 */
  name: string
  /** 绝对路径。 */
  path: string
  /** 是否存在。 */
  exists: boolean
  /** 字节数（缺席时为 0——配合 `exists` 读，不要单看数字）。 */
  bytes: number
  /** 修改时刻（ISO；缺席为 null）。 */
  mtime: string | null
  /** 距 `now` 的天数（缺席为 null）。 */
  ageDays: number | null
}

/** 一个家族（同名系列）的文件名版本冠军。 */
export interface VersionLeader {
  /** 家族名（版本段之前的部分）。 */
  family: string
  /** 该家族里文件名版本最高的那一份。 */
  name: string
  /** 该版本号。 */
  version: string
}

/** 一次取数的完整读数（`GET /state` 的 payload 主体）。 */
export interface TavernState {
  /** 取数时刻（ISO）。 */
  generatedAt: string
  /** 预设产物面。 */
  project: {
    /** 项目根绝对路径。 */
    dir: string
    /** 预设产物（mtime 降序；同刻按名字升序——确定性排序）。 */
    presets: PresetArtifact[]
    /** mtime 并列最新的文件名（**列全**：同刻同名次不假装只有一个）。 */
    newestByMtime: string[]
    /**
     * 每个**家族**（同名系列）里文件名版本号最高的一个。
     *
     * 为什么按家族分而不是全局取最高：文件名版本号**只在同一系列内可比**——
     * `梦鲸思客V4-0902` 与 `色欲之罪V3.4` 的 `V4` / `V3.4` 不是同一个坐标系，
     * 全局取最高会得出「V4 比 V3.4 新」这种跨家族的伪结论（本面板初版就踩了这一脚，测试当场抓住）。
     */
    versionLeaders: VersionLeader[]
  }
  /** 交接文档状态。 */
  handover: DocState
  /** 三个资产目录的计数。 */
  assets: DirCount[]
  /** 同名插件的脚本清单（只列存在性与新鲜度，**不执行**）。 */
  scripts: {
    /** 脚本目录绝对路径。 */
    dir: string
    /** 目录是否存在。 */
    exists: boolean
    /** 清单（mtime 降序）。 */
    files: FileEntry[]
    /** 最新的一个（空目录/缺席为 null）。 */
    newest: FileEntry | null
    /** 读取期间的具体错误。 */
    errors: string[]
  }
  /** 口径说明 + 读取错误（**错误在这里显式浮现，不吞**）。 */
  notes: string[]
}

/** 版本号比较：逐段数值比较，段数不同时缺段按 0。`a > b` 返回正数。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10))
  const pb = b.split('.').map((s) => Number.parseInt(s, 10))
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i += 1) {
    const x = Number.isFinite(pa[i]) ? (pa[i] ?? 0) : 0
    const y = Number.isFinite(pb[i]) ? (pb[i] ?? 0) : 0
    if (x !== y) return x - y
  }
  return 0
}

/**
 * 解析文件名里的版本号。
 * @param name - 文件名（如 `色欲之罪V3.4.json`）
 * @returns 版本串（如 `3.4`）；文件名里没有 `V<数字>` ⇒ `null`（不假装是 0）
 */
export function parsePresetVersion(name: string): string | null {
  const matched = VERSION_RE.exec(name)
  if (matched === null) return null
  return matched[1] ?? null
}

/** 家族名（同名系列）：文件名去掉扩展名与整个版本段（`色欲之罪V3.4.json` → `色欲之罪`，
 * `梦鲸思客V4-0902.json` → `梦鲸思客`）。
 * @param name - 文件名
 * @returns 家族名；无版本段时退化为「去掉扩展名的全名」
 */
export function familyOf(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  // 折叠连续空白：`夏瑾 天琴座 V2 Beta 1.0.json` 摘掉版本段后会留下双空格——
  // 家族名是**给人看的标签**，不是用于比较的键，折叠空白不影响分组正确性，只影响可读性。
  const stripped = base.replace(VERSION_RE, '').replace(/\s+/g, ' ').trim()
  return stripped === '' ? base : stripped
}

/** 人类可读字节数（只用于展示；判据读数一律用原始字节）。 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 距今小时/天数（mtime → now；now 早于 mtime 时给 0，不造负数）。 */
export function ageDaysOf(mtime: string, now: Date): number {
  const ms = now.getTime() - Date.parse(mtime)
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.round((ms / 86_400_000) * 10) / 10
}

/** 单文件 stat（失败 → null，并把具体原因 push 进 errors——不空吞）。 */
function statEntry(file: string): { bytes: number; mtime: string } | null {
  try {
    const st = statSync(file)
    if (!st.isFile()) return null
    return { bytes: st.size, mtime: st.mtime.toISOString() }
  } catch (e) {
    throw new Error(`${file}：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 列一个目录下的**文件**（一层，不递归）。
 * @param dir - 目录
 * @param errors - 错误收集器（目录缺失不算错：由调用方用 `exists` 表达）
 * @param suffix - 只收该后缀（小写比较）；缺省 = 全部文件
 * @returns mtime 降序（同刻按名字升序，保证确定性）
 */
export function listFiles(dir: string, errors: string[], suffix?: string): FileEntry[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    errors.push(`列目录失败 ${dir}：${e instanceof Error ? e.message : String(e)}`)
    return []
  }
  const out: FileEntry[] = []
  for (const name of names) {
    if (suffix !== undefined && !name.toLowerCase().endsWith(suffix)) continue
    let entry: { bytes: number; mtime: string } | null
    try {
      entry = statEntry(join(dir, name))
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
      continue
    }
    if (entry === null) continue // 目录/非常规文件：不是错误，只是不在这份「文件清单」里
    out.push({ name, bytes: entry.bytes, mtime: entry.mtime })
  }
  out.sort((a, b) => (a.mtime === b.mtime ? (a.name < b.name ? -1 : 1) : a.mtime < b.mtime ? 1 : -1))
  return out
}

/**
 * 递归统计一个目录下的文件数与字节数。
 *
 * 只数**真目录 / 真文件**（`withFileTypes` 的 lstat 语义）：符号链接不跟随——
 * 跟随会让一次取数在链接环上无限深入，也会让计数把别人的资产算进这里。
 * @param dir - 目录
 * @param errors - 错误收集器
 * @returns 存在性 + 文件数 + 字节数
 */
export function countFiles(dir: string, errors: string[]): { exists: boolean; files: number; bytes: number } {
  if (!existsSync(dir)) return { exists: false, files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  const walk = (current: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (e) {
      errors.push(`列目录失败 ${current}：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) {
          errors.push(`目录深度超过 ${String(MAX_DEPTH)} 层，未继续深入：${full}`)
          continue
        }
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      try {
        bytes += statSync(full).size
      } catch (e) {
        errors.push(`${full}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  walk(dir, 0)
  return { exists: true, files, bytes }
}

/** 读一个「文档」目标的状态（缺席 = `exists:false`，不是错误）。 */
export function docStateOf(dir: string, name: string, now: Date, errors: string[]): DocState {
  const path = join(dir, name)
  if (!existsSync(path)) return { name, path, exists: false, bytes: 0, mtime: null, ageDays: null }
  try {
    const entry = statEntry(path)
    if (entry === null) return { name, path, exists: false, bytes: 0, mtime: null, ageDays: null }
    return { name, path, exists: true, bytes: entry.bytes, mtime: entry.mtime, ageDays: ageDaysOf(entry.mtime, now) }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
    return { name, path, exists: false, bytes: 0, mtime: null, ageDays: null }
  }
}

/**
 * 采集酒馆项目状态（**只读**：仅 `existsSync` / `readdirSync` / `statSync`）。
 * @param deps - 两个只读数据源根
 * @param now - 取数时刻（显式传入 ⇒ 可离线单测；缺省 = 真实时钟）
 * @throws Error 当酒馆项目根本身不存在——**数据源缺席要响亮**，不能伪装成一份「全是 0」的正常读数
 */
export function collectTavernState(deps: TavernDeps, now: Date = new Date()): TavernState {
  if (!existsSync(deps.tavernDir)) {
    throw new Error(`酒馆项目目录不存在：${deps.tavernDir}（本面板只读，不会创建它）`)
  }
  const errors: string[] = []

  const presets: PresetArtifact[] = listFiles(deps.tavernDir, errors, PRESET_SUFFIX).map((f) => ({
    ...f,
    version: parsePresetVersion(f.name),
  }))
  const newestMtime = presets[0]?.mtime ?? null
  const newestByMtime = newestMtime === null ? [] : presets.filter((p) => p.mtime === newestMtime).map((p) => p.name)

  let versionLeaders: VersionLeader[] = []
  {
    const leaders = new Map<string, VersionLeader>()
    for (const preset of presets) {
      if (preset.version === null) continue
      const family = familyOf(preset.name)
      const current = leaders.get(family)
      if (current === undefined || compareVersions(preset.version, current.version) > 0) {
        leaders.set(family, { family, name: preset.name, version: preset.version })
      }
    }
    // 家族名升序（码位序：确定性优先于「看起来像字典」）
    versionLeaders = [...leaders.values()].sort((a, b) => (a.family < b.family ? -1 : 1))
  }

  const assets: DirCount[] = ASSET_DIRS.map((name) => {
    const dir = join(deps.tavernDir, name)
    const dirErrors: string[] = []
    const counted = countFiles(dir, dirErrors)
    return { name, path: dir, exists: counted.exists, files: counted.files, bytes: counted.bytes, errors: dirErrors }
  })

  const scriptsDir = join(deps.dreamTavernDir, 'scripts')
  const scriptErrors: string[] = []
  const scriptFiles = listFiles(scriptsDir, scriptErrors)

  const notes: string[] = [
    '只读取证：本面板对 tavern/ 只做 existsSync / readdirSync / statSync，从不写任何文件、从不执行任何脚本。',
    '「最新」有两个口径，别混用：newestByMtime = 磁盘上**最后被写**的那一份；versionLeaders = **各家族内文件名版本号最高**的那一份。'
      + '版本号取自 `V<数字>` 段，是**文件名事实，不是内容解析**；不同家族之间的版本号不可比（`V4` 与 `V3.4` 不是同一坐标系），所以按家族分组给出。',
    `新鲜度口径：stale = mtime 距今超过 ${String(STALE_DAYS)} 天（阈值是本面板的显式常量，不是推断）。`,
    '资产计数为**递归**文件数（只数真文件，符号链接不跟随）；脚本清单只列存在性与 mtime，面板不会运行它们。'
      + '⚠ 口径边界：这是**文件系统**读数，不是「内容资产」读数——`文风/`、`剧本素材/` 下含 `.git/`（版本库元数据）'
      + '与 `__pycache__/`（衍生缓存）这类目录，它们会被同样计进文件数里。',
    `数据源：${deps.tavernDir.replace(/\\/g, '/')} · ${scriptsDir.replace(/\\/g, '/')}`,
  ]
  const allErrors = [...errors, ...assets.flatMap((a) => a.errors), ...scriptErrors]
  if (allErrors.length > 0) {
    notes.push(`⚠ 本次取数有 ${String(allErrors.length)} 条读取错误（如实列出，未按 0 处理）：`)
    for (const line of allErrors.slice(0, 10)) notes.push(`  - ${line}`)
  }

  return {
    generatedAt: now.toISOString(),
    project: { dir: deps.tavernDir, presets, newestByMtime, versionLeaders },
    handover: docStateOf(deps.tavernDir, HANDOVER_NAME, now, errors),
    assets,
    scripts: { dir: scriptsDir, exists: existsSync(scriptsDir), files: scriptFiles, newest: scriptFiles[0] ?? null, errors: scriptErrors },
    notes,
  }
}

/** 新鲜度 → tone（超过 STALE_DAYS 记 warn；缺席另有表达，不走这里）。 */
function freshnessTone(mtime: string | null, now: Date): Tone {
  if (mtime === null) return 'muted'
  return ageDaysOf(mtime, now) > STALE_DAYS ? 'warn' : 'ok'
}

/** 时刻展示（`2026-09-21 00:30`；本地面 + UTC 标注见视图口径行——面板只做截断，不改语义）。 */
function stamp(mtime: string | null): string {
  return mtime === null ? '—' : mtime.slice(0, 16).replace('T', ' ')
}

/**
 * 把读数编译成视图规格（§4.2 轻量模式：宿主代渲染的一页摘要）。
 * @param deps - 两个只读数据源根
 * @param _params - **不接受任何参数**（面板的取数面是固定的；这里显式忽略，与 handle 的严格 404 同精神）
 */
export function toTavernSpec(deps: TavernDeps, _params: Record<string, string> = {}): ViewSpec {
  const now = new Date()
  const state = collectTavernState(deps, now)
  const assetFiles = state.assets.reduce((sum, a) => sum + a.files, 0)
  const assetBytes = state.assets.reduce((sum, a) => sum + a.bytes, 0)
  const newestName = state.project.newestByMtime[0] ?? null
  const latestPreset = state.project.presets[0] ?? null
  // 家族数在指标卡里会挤，只显示「名字最短的那个家族冠军」的版本号，并把家族名放进 hint
  const leader = state.project.versionLeaders.reduce<VersionLeader | null>(
    (best, item) => (best === null || item.family.length < best.family.length ? item : best),
    null,
  )

  return {
    blocks: [
      {
        kind: 'metrics',
        title: '酒馆项目总览（只读）',
        items: [
          { label: '预设产物', value: String(state.project.presets.length), tone: state.project.presets.length > 0 ? 'ok' : 'warn', hint: 'tavern/*.json' },
          {
            label: '最新版本',
            value: leader === null ? '—' : `V${leader.version}`,
            hint: leader === null ? '无带版本号的文件名' : `家族冠军最少者：${leader.family}（共 ${String(state.project.versionLeaders.length)} 个家族）`,
          },
          {
            label: '最后写入',
            value: newestName ?? '—',
            tone: freshnessTone(latestPreset?.mtime ?? null, now),
            hint: stamp(latestPreset?.mtime ?? null),
          },
          { label: '交接文档', value: state.handover.exists ? humanBytes(state.handover.bytes) : '缺失', tone: state.handover.exists ? 'ok' : 'warn', hint: stamp(state.handover.mtime) },
          { label: '资产文件', value: String(assetFiles), tone: assetFiles > 0 ? 'ok' : 'warn', hint: humanBytes(assetBytes) },
          { label: '插件脚本', value: String(state.scripts.files.length), tone: state.scripts.exists ? 'ok' : 'warn', hint: stamp(state.scripts.newest?.mtime ?? null) },
        ],
      },
      {
        kind: 'table',
        title: '预设产物（tavern/*.json，按最后写入降序）',
        columns: [
          { key: 'name', label: '文件' },
          { key: 'version', label: '文件名版本' },
          { key: 'bytes', label: '字节', align: 'right' },
          { key: 'size', label: '大小', align: 'right' },
          { key: 'mtime', label: '最后写入(UTC)' },
          { key: 'fresh', label: '新鲜度' },
          { key: 'mark', label: '标记' },
        ],
        rows: state.project.presets.map((p) => ({
          name: p.name,
          version: p.version ?? '—',
          bytes: p.bytes,
          size: humanBytes(p.bytes),
          mtime: stamp(p.mtime),
          fresh: `${String(ageDaysOf(p.mtime, now))} 天前`,
          mark: state.project.newestByMtime.includes(p.name)
            ? '最新写入'
            : (state.project.versionLeaders.some((l) => l.name === p.name) ? '家族版本最高' : ''),
        })),
      },
      {
        kind: 'table',
        title: '资产计数（递归文件数）',
        columns: [
          { key: 'name', label: '目录' },
          { key: 'files', label: '文件数', align: 'right' },
          { key: 'bytes', label: '字节', align: 'right' },
          { key: 'size', label: '大小', align: 'right' },
          { key: 'state', label: '状态' },
        ],
        rows: state.assets.map((a) => ({
          name: `${a.name}/`,
          files: a.files,
          bytes: a.bytes,
          size: humanBytes(a.bytes),
          state: a.exists ? (a.errors.length > 0 ? `有 ${String(a.errors.length)} 条读取错误` : 'ok') : '目录缺失',
        })),
      },
      {
        kind: 'table',
        title: '同名插件脚本（dsh-dream-tavern/scripts/，只列存在性与新鲜度——不执行）',
        columns: [
          { key: 'name', label: '文件' },
          { key: 'bytes', label: '字节', align: 'right' },
          { key: 'mtime', label: '最后写入(UTC)' },
          { key: 'fresh', label: '新鲜度' },
        ],
        rows: state.scripts.files.map((f) => ({
          name: f.name,
          bytes: f.bytes,
          mtime: stamp(f.mtime),
          fresh: `${String(ageDaysOf(f.mtime, now))} 天前`,
        })),
      },
      {
        kind: 'text',
        title: '来源与口径',
        lines: [
          ...state.notes,
          '只读面板：没有动作表，也不提供任何写入/执行通道——创作资产只在主人的通道里改。',
        ],
      },
    ],
  }
}

/** 反代面的 JSON 响应头（与审计面板同形）。 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/**
 * 取数**成功**但读取期间仍有错误时，把错误行浮到载荷顶层（视图与自带前端都会显示）。
 *
 * 为什么必须有：`collectTavernState` 不会因为个别条目读不到就抛错（一次坏文件不该让整页失败），
 * 但「成功返回 200」很容易被读成「数据完整」——而读取失败恰恰表现为**计数偏小**。
 * ⇒ 有错就把它顶到明面上，让「读到的数」与「读数的完整性」一起被看见（§5.10 静默失败 = 死亡温床）。
 * @param state - 本次读数
 */
function stateErrorLines(state: TavernState): string[] {
  return state.notes.filter((line) => line.startsWith('  - '))
}

/**
 * `/api/panel/tavern/*` 的数据接口（§4.7-3 反代面）。
 *
 * **只认 `GET /state`**，且路径是**固定字面量**：面板不接受任何来自请求的路径片段，
 * 因此这里没有可拼接的路径输入面——穿越不是「被校验拦下」，而是**不存在**。
 * @param deps - 两个只读数据源根
 * @param req - 命名空间内请求（宿主归一化后的纯数据，可离线单测）
 */
export function handleTavernRequest(deps: TavernDeps, req: PanelHttpRequest): PanelHttpResponse {
  const path = req.path.replace(/\/+$/, '') === '' ? '/' : req.path.replace(/\/+$/, '')
  if (path !== '/state') {
    return {
      status: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: false, error: `未知路径 ${req.path}（本面板只提供 GET /state）` }),
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return { status: 405, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: `只读面板：仅支持 GET（收到 ${req.method}）` }) }
  }
  try {
    const state = collectTavernState(deps)
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true, errors: stateErrorLines(state), state }) }
  } catch (e) {
    // 数据源缺席 = 503 且带原因：面板宁可响亮地报「读不到」，也不给一份「全是 0」的假读数
    return {
      status: 503,
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    }
  }
}

/**
 * 构造「酒馆」面板贡献（只读 · 三个面都给）。
 *
 * - `view()` = 轻量模式：宿主代渲染的一页摘要——**面板定义顺序里的第一个**，卡片上也能一眼看见家族版本冠军；
 * - `frontend` = 自带前端：`/panel-assets/tavern/index.html`（宿主原样托管，零外部依赖）；
 * - `handle()` = 反代面：`GET /api/panel/tavern/state` 的只读 JSON。
 *
 * 三个面都给是刻意的：它是 §4.7 降级矩阵里**信息量最大的一格**（卡片 + iframe + 反代），
 * 因此也是这条契约最好的活体样本——任一环断掉都能从这一页看出来。
 * @param deps - 两个只读数据源根
 */
export function createTavernPanel(deps: TavernDeps): PanelContribution {
  return {
    id: 'tavern',
    title: '酒馆（色欲之罪）',
    order: 60,
    // 面板按贡献字段顺序决定「优先形态」：frontend 在 view 之前 ⇒ 宿主优先用自带前端
    // （入口页显示卡片、点进去加载 entry）；`view()` 仍交给外壳做聚合摘要。顺序反了就会退回轻量模式。
    frontend: { assetsDir: 'web/tavern', entry: 'index.html' },
    handle: (req) => handleTavernRequest(deps, req),
    view: (params) => toTavernSpec(deps, params),
    icon: '🍷',
    description: '酒馆项目状态（只读）：预设产物与最新版本 / 交接文档 / 素材·文风·剧本素材计数 / 同名插件脚本清单——绝不写创作资产、绝不执行脚本',
    style: { accent: '#fb7185', density: 'compact' },
  }
}
