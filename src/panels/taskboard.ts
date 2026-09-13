/**
 * panels/taskboard.ts — 内置面板：任务板
 *
 * 数据源（自包含取数，不依赖 dsh-agent-taskboard 的实现细节）：
 *   - 板面：`<workspace>/.taskboard/tasks.json` —— `{tasks:[{id,title,description,type,priority,tags,status,assignee?,summary?,createdAt,updatedAt}]}`
 *   - 归档：`<workspace>/.taskboard/archive/terminal-YYYY-MM-DD.json` —— `{archivedAt,note,tasks:[]}`
 *
 * 唯一的写动作 `archive-terminal` 与 `scripts/taskboard-archive-terminal.py` **同语义**：
 *   终态（done/cancelled）任务按 **id 去重**追加进当日归档文件，随后才把板面写成只含非终态项；
 *   **归档写失败即中止，板面一字不改**（脚本作者的原始纪律）。归档文件损坏时先另存 `.corrupt-<HHMMSS>` 再重建。
 *
 * 面板纪律（docs/semantic.md §4.2/§4.3）：只交声明——视图规格 + 动作表；不碰路由、不写 HTML/DOM。
 * @module dsh-panel/panels/taskboard
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PanelContribution, ViewSpec } from '../types.ts'

/** 面板依赖：任务板位于 workspace 下的 `.taskboard/`。 */
export interface TaskboardDeps {
  /** 工作区根（`DSH_HOME` 的父目录，如 E:/alice）。 */
  workspace: string
}

/** 终态状态集合（与归档脚本、插件层轮转语义一致）。 */
const TERMINAL: readonly string[] = ['done', 'cancelled']

/** 板面任务条目（字段与 `.taskboard/tasks.json` 实际落盘一致）。 */
export interface TaskRecord {
  id?: string
  title?: string
  description?: string
  type?: string
  priority?: string
  tags?: string[]
  status?: string
  assignee?: string
  summary?: string
  createdAt?: string
  updatedAt?: string
}

/** 归档文件条目（`.taskboard/archive/terminal-*.json`）。 */
export interface ArchiveRecord {
  archivedAt?: string
  note?: string
  tasks?: TaskRecord[]
}

/** 视图用的归档摘要。 */
export interface ArchiveSummary {
  file: string
  archivedAt: string
  count: number
}

/** 板面文件路径。 */
export function boardFileOf(deps: TaskboardDeps): string {
  return join(deps.workspace, '.taskboard', 'tasks.json')
}

/** 归档目录。 */
export function archiveDirOf(deps: TaskboardDeps): string {
  return join(deps.workspace, '.taskboard', 'archive')
}

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value)
}

/** 本地日期 `YYYY-MM-DD`（对齐 Python `time.strftime('%Y-%m-%d')`）。 */
function localDate(at: Date): string {
  return `${String(at.getFullYear())}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

/** 本地时间戳 `YYYY-MM-DDTHH:MM:SS`（对齐 Python `time.strftime('%Y-%m-%dT%H:%M:%S')`）。 */
function localStamp(at: Date): string {
  return `${localDate(at)}T${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`
}

/** 秒级时刻串 `HHMMSS`（损坏归档另存后缀）。 */
function localClock(at: Date): string {
  return `${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`
}

/** 原子写（同目录临时文件 + rename）：读者永远看不到半截文件。 */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.panel-tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** 读板面（缺失/损坏 → 空板 + note，只读路径永不抛错）。 */
export function readBoard(file: string): { tasks: TaskRecord[]; note: string | null } {
  if (!existsSync(file)) return { tasks: [], note: `任务板文件缺失：${file}` }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: unknown }
    const tasks = Array.isArray(parsed.tasks) ? (parsed.tasks as TaskRecord[]) : []
    return { tasks, note: Array.isArray(parsed.tasks) ? null : '任务板 tasks 字段不是数组（按空板处理）' }
  } catch (e) {
    return { tasks: [], note: `任务板解析失败：${String(e)}` }
  }
}

/** 列出归档文件摘要（按 archivedAt 降序；文件名排序兜底）。 */
export function listArchives(dir: string): ArchiveSummary[] {
  const out: ArchiveSummary[] = []
  try {
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('terminal-') || !name.endsWith('.json')) continue
      const file = join(dir, name)
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as ArchiveRecord
        out.push({
          file: name,
          archivedAt: parsed.archivedAt ?? name.replace(/^terminal-/, '').replace(/\.json$/, ''),
          count: Array.isArray(parsed.tasks) ? parsed.tasks.length : 0,
        })
      } catch {
        out.push({ file: name, archivedAt: '（损坏，无法解析）', count: 0 })
      }
    }
  } catch { /* 目录不可读 → 空列表（如实显示 0，不假装） */ }
  return out.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0))
}

/** 计数。 */
function countBy(tasks: TaskRecord[], status: string): number {
  return tasks.filter((t) => t.status === status).length
}

/**
 * 把任务板编译成视图规格。
 * @param deps - 工作区路径
 * @returns 视图规格（宿主白名单块）
 */
export function toTaskboardSpec(deps: TaskboardDeps): ViewSpec {
  const boardFile = boardFileOf(deps)
  const { tasks, note } = readBoard(boardFile)
  const archives = listArchives(archiveDirOf(deps))
  const pending = countBy(tasks, 'pending')
  const claimed = countBy(tasks, 'claimed')
  const done = countBy(tasks, 'done')
  const cancelled = countBy(tasks, 'cancelled')

  const lines: string[] = []
  if (note !== null) lines.push(`⚠ ${note}`)
  lines.push(`板面文件：${boardFile.replace(/\\/g, '/')}（${String(tasks.length)} 条）`)
  if (archives.length === 0) {
    lines.push('归档：尚无 terminal-*.json 归档文件。')
  } else {
    const latest = archives[0]
    const totalArchived = archives.reduce((sum, a) => sum + a.count, 0)
    lines.push(`归档：${String(archives.length)} 个文件 · 累计 ${String(totalArchived)} 条 · 最近 ${String(latest?.archivedAt ?? '—')}（${String(latest?.count ?? 0)} 条）`)
    for (const a of archives.slice(0, 5)) lines.push(`  · ${a.file} — ${a.archivedAt} · ${String(a.count)} 条`)
  }
  lines.push('归档语义：终态任务按 id 去重追加进当日 terminal-<日期>.json，并从板面移除；归档写失败则板面不改动。')

  return {
    blocks: [
      {
        kind: 'metrics',
        title: '任务板总览',
        items: [
          { label: '待办', value: String(pending), tone: pending > 0 ? 'warn' : 'muted' },
          { label: '进行中', value: String(claimed), tone: claimed > 0 ? 'ok' : 'muted' },
          { label: '已完成', value: String(done), tone: 'muted' },
          { label: '已取消', value: String(cancelled), tone: 'muted' },
          { label: '板面合计', value: String(tasks.length) },
        ],
      },
      {
        kind: 'table',
        title: '板面任务（pending / claimed）',
        columns: [
          { key: 'id', label: 'id' },
          { key: 'title', label: '标题' },
          { key: 'priority', label: '优先级' },
          { key: 'status', label: '状态' },
          { key: 'assignee', label: '负责人' },
          { key: 'updatedAt', label: '更新' },
        ],
        rows: tasks.map((t) => ({
          id: t.id ?? '—',
          title: (t.title ?? '（无标题）').slice(0, 90),
          priority: t.priority ?? 'normal',
          status: t.status ?? '—',
          assignee: t.assignee ?? '—',
          updatedAt: (t.updatedAt ?? t.createdAt ?? '—').slice(0, 16).replace('T', ' '),
        })),
      },
      {
        kind: 'actions',
        title: '动作',
        items: [{ actionId: 'archive-terminal', label: '归档终态任务', level: 'write' }],
      },
      {
        kind: 'text',
        title: '归档与来源',
        lines,
      },
    ],
  }
}

/**
 * 归档终态任务（与 `scripts/taskboard-archive-terminal.py` 同语义）。
 * @param deps - 工作区路径
 * @param now - 派发时刻（由宿主注入，便于离线单测）
 * @returns 动作结果（ok=false 时板面保证未改动）
 */
export function archiveTerminal(deps: TaskboardDeps, now: Date): { ok: boolean; message: string; data: Record<string, unknown> } {
  const boardFile = boardFileOf(deps)
  if (!existsSync(boardFile)) {
    return { ok: false, message: `任务板文件不存在：${boardFile}`, data: { board: boardFile } }
  }
  let board: { tasks?: TaskRecord[] }
  try {
    board = JSON.parse(readFileSync(boardFile, 'utf8')) as { tasks?: TaskRecord[] }
  } catch (e) {
    return { ok: false, message: `任务板解析失败（未改动）：${String(e)}`, data: { board: boardFile } }
  }
  const tasks = Array.isArray(board.tasks) ? board.tasks : []
  const keep = tasks.filter((t) => !TERMINAL.includes(t.status ?? ''))
  const archived = tasks.filter((t) => TERMINAL.includes(t.status ?? ''))
  if (archived.length === 0) {
    return { ok: true, message: '无可归档项（板面无终态任务）。', data: { archived: 0, kept: keep.length } }
  }

  const archiveDir = archiveDirOf(deps)
  const target = join(archiveDir, `terminal-${localDate(now)}.json`)
  try {
    mkdirSync(archiveDir, { recursive: true })
    let prev: ArchiveRecord = { tasks: [] }
    if (existsSync(target)) {
      try {
        prev = JSON.parse(readFileSync(target, 'utf8')) as ArchiveRecord
      } catch {
        // 损坏则保留原文件另存（与脚本一致：不静默丢历史）
        renameSync(target, `${target}.corrupt-${localClock(now)}`)
        prev = { tasks: [] }
      }
    }
    const prevTasks = Array.isArray(prev.tasks) ? prev.tasks : []
    const seen = new Set(prevTasks.map((t) => t.id))
    const merged = [...prevTasks, ...archived.filter((t) => !seen.has(t.id))]
    writeAtomic(target, JSON.stringify({
      archivedAt: localStamp(now),
      note: '任务板终态归档（完成即归档；恢复=把 tasks 项并回 tasks.json）',
      tasks: merged,
    }, null, 2))
    // 归档落盘成功之后才改板面——归档失败不改板面（脚本原始纪律）
    writeAtomic(boardFile, JSON.stringify({ tasks: keep }, null, 2))
    return {
      ok: true,
      message: `已归档 ${String(archived.length)} 条终态任务 → ${target.replace(/\\/g, '/')}（累计 ${String(merged.length)}）；板面保留 ${String(keep.length)} 条。`,
      data: { archived: archived.length, kept: keep.length, target, total: merged.length },
    }
  } catch (e) {
    return { ok: false, message: `归档失败，板面未改动：${String(e)}`, data: { target } }
  }
}

/**
 * 构造「任务板」面板贡献。
 * @param deps - 工作区路径
 * @returns 面板贡献
 */
export function createTaskboardPanel(deps: TaskboardDeps): PanelContribution {
  return {
    id: 'taskboard',
    title: '任务板',
    order: 20,
    icon: 'check',
    description: '任务板板面与归档：待办/进行中/终态计数、任务清单、终态归档（写入 archive/terminal-<日期>.json）',
    view: () => toTaskboardSpec(deps),
    actions: {
      'archive-terminal': {
        label: '归档终态任务',
        level: 'write',
        run: (_params, ctx) => archiveTerminal(deps, new Date(ctx.now)),
      },
    },
  }
}
