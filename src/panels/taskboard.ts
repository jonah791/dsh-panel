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
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { actionItems } from '../registry.ts'
import type { ActionSpec, PanelContribution, ViewSpec } from '../types.ts'

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
  claimedAt?: string
  doneAt?: string
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
  lines.push('写入动作：新建 / 认领 / 完成（write，直接生效）；「删除任务」标 destructive + requiresApproval——判定层 403 拒发、执行层再拒一次（面板不得成为绕过「须请示三类」的通道）。')
  lines.push('写入纪律：解析失败一律拒绝写入（只读路径可宽容按空板显示，写入路径绝不拿空板覆盖真实文件）。')

  const archivedTotal = archives.reduce((sum, a) => sum + a.count, 0)

  return {
    // 分页组织（tabs 是纯客户端切换）：概览看数、写操作真干活、来源与归档查账。
    blocks: [
      {
        kind: 'tabs',
        items: [
          {
            label: '概览',
            badge: String(tasks.length),
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
                  { label: '累计归档', value: String(archivedTotal) },
                ],
              },
              {
                kind: 'chart',
                title: '状态分布',
                chart: 'bar',
                unit: ' 条',
                series: [
                  { label: '待办', value: pending, tone: 'warn' },
                  { label: '进行中', value: claimed, tone: 'ok' },
                  { label: '已完成', value: done, tone: 'muted' },
                  { label: '已取消', value: cancelled, tone: 'bad' },
                ],
              },
              {
                kind: 'progress',
                title: '闭环度（已终态 / 全部经手）',
                items: [{
                  label: '终态占比',
                  value: done + cancelled + archivedTotal,
                  max: Math.max(1, tasks.length + done + cancelled + archivedTotal),
                  tone: 'ok',
                  hint: `归档 ${String(archivedTotal)} · 板面 ${String(tasks.length)}`,
                }],
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
            ],
          },
          {
            label: '写操作',
            blocks: [
              {
                kind: 'form',
                title: '新建任务',
                actionId: 'post',
                submitLabel: '新建',
                note: '直接写入 .taskboard/tasks.json（write 级，无需确认）',
                fields: [
                  { name: 'title', label: '标题', type: 'text', required: true, placeholder: '一句话说清要做什么' },
                  { name: 'type', label: '类型', type: 'select', options: [{ value: 'short', label: '短期' }, { value: 'long', label: '长期' }] },
                  { name: 'priority', label: '优先级', type: 'select', options: ['low', 'normal', 'high'] },
                  { name: 'description', label: '详情', type: 'textarea', placeholder: '验收判据 / 上下文 / 关联任务' },
                ],
              },
              {
                kind: 'form',
                title: '认领 / 完成任务',
                actionId: 'claim',
                submitLabel: '认领',
                note: '认领：pending → claimed；完成请在下方表单填 id（claimed → done 并归档）',
                fields: [
                  { name: 'taskId', label: '任务 id', type: 'text', required: true, placeholder: 't-xxxxxxxx' },
                  { name: 'assignee', label: '负责人', type: 'text', placeholder: '缺省 alice' },
                ],
              },
              {
                kind: 'form',
                title: '完成任务',
                actionId: 'complete',
                submitLabel: '完成并归档',
                fields: [
                  { name: 'taskId', label: '任务 id', type: 'text', required: true },
                  { name: 'summary', label: '完成摘要', type: 'textarea', placeholder: '做了什么 / 证据 / 遗留' },
                ],
              },
              {
                kind: 'actions',
                title: '全部动作（含审批门动作）',
                items: actionItems(taskboardActions(deps)),
              },
            ],
          },
          {
            label: '来源与归档',
            badge: String(archives.length),
            blocks: [
              { kind: 'text', title: '归档与来源', lines },
              {
                kind: 'list',
                title: '归档文件',
                items: archives.slice(0, 10).map((a) => ({
                  title: a.file,
                  subtitle: `${a.archivedAt} · ${String(a.count)} 条`,
                  tags: ['terminal'],
                })),
              },
            ],
          },
        ],
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

// ---------- 写入通道（动作） ----------
//
// 语义镜像：与 `dsh-agent-taskboard` 的 Remote（`mutate` 的状态流转 + `post` 新建）**同语义**——
//   id = `t-` + uuid 前 8 位；createdAt/claimedAt/doneAt 用 UTC ISO；claim 仅限 pending、
//   complete 仅限 claimed（默认负责人 `alice`）；完成即归档终态。
// 与只读路径的关键差别：**写入前必须严格读**——解析失败一律拒绝写入，绝不拿「按空板处理」
//   的结果覆盖真实文件（只读可以宽容，写入必须苛刻）。
// 诚实声明的一处**有意发散**：写入时一并维护 `updatedAt`（插件的写路径不维护它，
//   但其轮转逻辑 `timestampOf` 把 `updatedAt ?? createdAt` 当「最后修改」读——补上它是让该字段名副其实）。

/** 写入通道结果（与归档动作同形状）。 */
export interface MutateResult {
  ok: boolean
  message: string
  data: Record<string, unknown>
}

/** 严格读板面：缺失 = 允许建板；解析失败 / 形状不符 = 拒绝写入。 */
export function readBoardStrict(file: string): { ok: true; tasks: TaskRecord[] } | { ok: false; error: string } {
  if (!existsSync(file)) return { ok: true, tasks: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: unknown }
    if (!Array.isArray(parsed.tasks)) {
      return { ok: false, error: '任务板 tasks 字段不是数组——拒绝写入（避免覆盖真实数据）' }
    }
    return { ok: true, tasks: parsed.tasks as TaskRecord[] }
  } catch (e) {
    return { ok: false, error: `任务板解析失败——拒绝写入（避免覆盖真实数据）：${String(e)}` }
  }
}

/**
 * 读-改-写通道：**拒绝路径零副作用**（未得到 ok 就不写盘）。
 * @param deps - 工作区路径
 * @param mutate - 就地修改 tasks 的纯判定+改写函数
 */
function mutateBoard(
  deps: TaskboardDeps,
  mutate: (tasks: TaskRecord[]) => MutateResult,
): MutateResult {
  const file = boardFileOf(deps)
  const read = readBoardStrict(file)
  if (!read.ok) return { ok: false, message: read.error, data: { board: file } }
  const outcome = mutate(read.tasks)
  if (!outcome.ok) return outcome
  try {
    writeAtomic(file, JSON.stringify({ tasks: read.tasks }, null, 2))
  } catch (e) {
    return { ok: false, message: `写入失败：${String(e)}`, data: { board: file } }
  }
  return outcome
}

/** 新建任务入参。 */
export interface PostInput {
  title: string
  description?: string
  type?: string
  priority?: string
  tags?: string[]
}

/**
 * 新建任务（pending）。
 * @param deps - 工作区路径
 * @param now - 派发时刻（宿主注入）
 * @param input - 任务字段
 */
export function postTask(deps: TaskboardDeps, now: Date, input: PostInput): MutateResult {
  const title = input.title.trim()
  if (title === '') return { ok: false, message: '标题不能为空（title-required）', data: {} }
  const task = {
    id: `t-${randomUUID().slice(0, 8)}`,
    title,
    description: input.description ?? '',
    type: input.type === 'long' ? 'long' : 'short',
    priority: input.priority === undefined || input.priority === '' ? 'normal' : input.priority,
    tags: input.tags ?? [],
    status: 'pending',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  } satisfies TaskRecord
  const result = mutateBoard(deps, (tasks) => {
    tasks.push(task)
    return { ok: true, message: `已新建任务 ${String(task.id)}：${task.title}（pending）`, data: { taskId: task.id, board: boardFileOf(deps) } }
  })
  return result
}

/**
 * 认领任务（pending → claimed）。
 * @param deps - 工作区路径
 * @param now - 派发时刻
 * @param taskId - 目标任务 id
 * @param assignee - 负责人（缺省 alice，与插件一致）
 */
export function claimTask(deps: TaskboardDeps, now: Date, taskId: string, assignee?: string): MutateResult {
  return mutateBoard(deps, (tasks) => {
    const task = tasks.find((t) => t.id === taskId)
    if (task === undefined) return { ok: false, message: `未找到任务 ${taskId}（task-not-found）`, data: {} }
    if (task.status !== 'pending') {
      return { ok: false, message: `任务 ${taskId} 当前状态为 ${String(task.status)}，仅 pending 可认领（not-pending）`, data: { status: task.status } }
    }
    task.status = 'claimed'
    task.assignee = assignee === undefined || assignee === '' ? 'alice' : assignee
    task.claimedAt = now.toISOString()
    task.updatedAt = now.toISOString()
    return { ok: true, message: `已认领 ${taskId}（claimed，负责人 ${String(task.assignee)}）`, data: { taskId, status: 'claimed', assignee: task.assignee } }
  })
}

/**
 * 完成任务（claimed → done），随后归档终态（完成即归档，与插件轮转同语义）。
 * 归档失败**不回滚**完成（完成已落盘是事实），但在 message 里如实上报。
 * @param deps - 工作区路径
 * @param now - 派发时刻
 * @param taskId - 目标任务 id
 * @param summary - 完成摘要
 */
export function completeTask(deps: TaskboardDeps, now: Date, taskId: string, summary?: string): MutateResult {
  const result = mutateBoard(deps, (tasks) => {
    const task = tasks.find((t) => t.id === taskId)
    if (task === undefined) return { ok: false, message: `未找到任务 ${taskId}（task-not-found）`, data: {} }
    if (task.status !== 'claimed') {
      return { ok: false, message: `任务 ${taskId} 当前状态为 ${String(task.status)}，仅 claimed 可完成（not-claimed）`, data: { status: task.status } }
    }
    task.status = 'done'
    task.summary = summary ?? ''
    task.doneAt = now.toISOString()
    task.updatedAt = now.toISOString()
    return { ok: true, message: `已完成 ${taskId}（done）`, data: { taskId, status: 'done' } }
  })
  if (!result.ok) return result
  const archived = archiveTerminal(deps, now)
  return {
    ok: true,
    message: `${result.message}；${archived.message}`,
    data: { ...result.data, archive: archived.data, archiveOk: archived.ok },
  }
}

/**
 * 删除任务：**面板不提供该通道**（两层拒绝）。
 * ① 判定层：动作声明 `requiresApproval: true` → 派发前即 403（零副作用）；
 * ② 执行层：即便判定层被绕过，run 自身也拒绝——删除属「须请示三类（删数据）」。
 * @param taskId - 目标任务 id（只用于回执文本）
 */
export function removeTaskRefused(taskId: string): MutateResult {
  return {
    ok: false,
    message: `拒绝：删除任务（${taskId}）属须请示三类（删数据）——面板不得成为绕过主体性铁律的通道；请爱丽丝在正常通道取得主人授权后执行。`,
    data: { taskId },
  }
}

/**
 * 任务板动作表（**视图与贡献共用同一份**：避免「显示的动作」与「可派的动作」漂移）。
 * @param deps - 工作区路径
 */
export function taskboardActions(deps: TaskboardDeps): Record<string, ActionSpec> {
  return {
    post: {
      label: '新建任务',
      level: 'write',
      params: { title: 'string', description: 'string', type: 'string', priority: 'string' },
      run: (params, ctx) => {
        const input: PostInput = { title: String(params.title ?? '') }
        if (typeof params.description === 'string') input.description = params.description
        if (typeof params.type === 'string') input.type = params.type
        if (typeof params.priority === 'string') input.priority = params.priority
        return postTask(deps, new Date(ctx.now), input)
      },
    },
    claim: {
      label: '认领任务',
      level: 'write',
      params: { taskId: 'string', assignee: 'string' },
      run: (params, ctx) => claimTask(
        deps,
        new Date(ctx.now),
        String(params.taskId ?? ''),
        typeof params.assignee === 'string' ? params.assignee : undefined,
      ),
    },
    complete: {
      label: '完成任务',
      level: 'write',
      params: { taskId: 'string', summary: 'string' },
      run: (params, ctx) => completeTask(
        deps,
        new Date(ctx.now),
        String(params.taskId ?? ''),
        typeof params.summary === 'string' ? params.summary : undefined,
      ),
    },
    'archive-terminal': {
      label: '归档终态任务',
      level: 'write',
      run: (_params, ctx) => archiveTerminal(deps, new Date(ctx.now)),
    },
    'delete-task': {
      label: '删除任务（须请示）',
      level: 'destructive',
      requiresApproval: true,
      params: { taskId: 'string' },
      run: (params) => removeTaskRefused(String(params.taskId ?? '')),
    },
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
    description: '任务板板面与流转：计数、分布图、新建/认领/完成、终态归档（写入 archive/terminal-<日期>.json）',
    style: { accent: '#f0b429', density: 'compact' },
    view: () => toTaskboardSpec(deps),
    actions: taskboardActions(deps),
  }
}
