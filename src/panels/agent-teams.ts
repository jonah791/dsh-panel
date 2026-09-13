/**
 * panels/agent-teams.ts — 内置面板：分身（AgentTeams）
 *
 * 数据源（**只读**）：`<workspace>/.agent-teams/<team>/team.json` + `<team>/inbox/*.jsonl`。
 * 字段以**真实落盘**为准（2026-09-13 实测 `.agent-teams/wq-factor-mining/team.json`）：
 *   - team：`{name,id,description,captainSessionId,createdAt,members,tasks,taskSeq}`
 *   - member：`{id,name,role,joinedAt,status}`（createdAt/joinedAt 是**毫秒数**）
 *   - task：`{id,subject,description,status,assignee,dependencies,createdAt,updatedAt,output?}`
 *     ——注意是 `subject`（不是 title），`objective`/`title` 字段并不存在。
 *   - inbox：每个成员一个 `<member>.jsonl`（一行一条消息）——积压 = 文件数 + 总行数。
 *
 * 面板纪律（docs/semantic.md §4.2/§4.3）：只交声明——视图规格，无动作（只读）。
 * @module dsh-panel/panels/agent-teams
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PanelContribution, ViewSpec } from '../types.ts'

/** 面板依赖：团队目录位于 workspace 下。 */
export interface AgentTeamsDeps {
  /** 工作区根（如 E:/alice）。 */
  workspace: string
}

/** 成员条目（字段名以实测落盘为准）。 */
interface TeamMember {
  id?: string
  name?: string
  role?: string
  joinedAt?: number
  status?: string
}

/** 任务条目（字段名以实测落盘为准：`subject` 而非 `title`）。 */
interface TeamTask {
  id?: string
  subject?: string
  description?: string
  status?: string
  assignee?: string
  dependencies?: string[]
  createdAt?: number
  updatedAt?: number
  output?: string
}

/** 团队条目。 */
interface TeamRecord {
  name?: string
  id?: string
  description?: string
  captainSessionId?: string
  createdAt?: number
  members?: TeamMember[]
  tasks?: TeamTask[]
  taskSeq?: number
}

/** 一个团队的视图投影。 */
export interface TeamSummary {
  id: string
  name: string
  description: string
  /** 队长会话 id（team.json 的 captainSessionId）。 */
  captainSessionId: string
  members: TeamMember[]
  tasks: TeamTask[]
  /** inbox 文件数。 */
  inboxFiles: number
  /** inbox 总消息行数（积压）。 */
  inboxMessages: number
  /** inbox 明细行（文件名 + 行数）。 */
  inboxDetail: string[]
  archived: boolean
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

/** 截断长文本。 */
function clip(text: string | undefined, max: number): string {
  const value = (text ?? '').trim().replace(/\s+/g, ' ')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** 毫秒数 → 本地短时刻（非数值 → 原样返回）。 */
function msToStamp(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const d = new Date(value)
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 统计 inbox：文件数与总行数（非空行）。 */
function scanInbox(dir: string): { files: number; messages: number; detail: string[] } {
  const detail: string[] = []
  let files = 0
  let messages = 0
  try {
    if (!existsSync(dir)) return { files, messages, detail }
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      try {
        if (!statSync(file).isFile()) continue
      } catch { continue }
      files += 1
      let n = 0
      try {
        n = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').length
      } catch { /* 单文件不可读 → 计 0 行但不隐藏文件 */ }
      messages += n
      detail.push(`${name}（${String(n)} 条）`)
    }
  } catch { /* 目录不可读 → 空 */ }
  detail.sort()
  return { files, messages, detail }
}

/** 读一个团队目录（无 team.json → undefined）。 */
function readTeam(dir: string, id: string, archived: boolean): TeamSummary | undefined {
  const record = readJson<TeamRecord>(join(dir, 'team.json'))
  if (record === undefined) return undefined
  const inbox = scanInbox(join(dir, 'inbox'))
  return {
    id,
    name: record.name ?? id,
    description: record.description ?? '',
    captainSessionId: record.captainSessionId ?? '',
    members: Array.isArray(record.members) ? record.members : [],
    tasks: Array.isArray(record.tasks) ? record.tasks : [],
    inboxFiles: inbox.files,
    inboxMessages: inbox.messages,
    inboxDetail: inbox.detail,
    archived,
  }
}

/** 扫描 `.agent-teams/`（在册团队）与 `.agent-teams/archive/`（归档团队）。 */
export function scanTeams(deps: AgentTeamsDeps): { active: TeamSummary[]; archived: TeamSummary[] } {
  const root = join(deps.workspace, '.agent-teams')
  const active: TeamSummary[] = []
  const archived: TeamSummary[] = []
  try {
    if (!existsSync(root)) return { active, archived }
    for (const name of readdirSync(root)) {
      if (name.startsWith('.')) continue
      const dir = join(root, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch { continue }
      if (name === 'archive') {
        try {
          for (const sub of readdirSync(dir)) {
            const subDir = join(dir, sub)
            try {
              if (!statSync(subDir).isDirectory()) continue
            } catch { continue }
            const team = readTeam(subDir, sub, true)
            if (team !== undefined) archived.push(team)
          }
        } catch { /* archive 不可读 → 跳过 */ }
        continue
      }
      const team = readTeam(dir, name, false)
      if (team !== undefined) active.push(team)
    }
  } catch { /* 目录不可读 → 空 */ }
  const byName = (a: TeamSummary, b: TeamSummary): number => a.name.localeCompare(b.name)
  return { active: active.sort(byName), archived: archived.sort(byName) }
}

/**
 * 把分身状态编译成视图规格。
 * @param deps - 工作区根
 * @returns 视图规格（宿主白名单块）
 */
export function toAgentTeamsSpec(deps: AgentTeamsDeps): ViewSpec {
  const { active, archived } = scanTeams(deps)
  const all = [...active, ...archived]
  const memberCount = all.reduce((sum, t) => sum + t.members.length, 0)
  const taskCount = all.reduce((sum, t) => sum + t.tasks.length, 0)
  const inboxFiles = all.reduce((sum, t) => sum + t.inboxFiles, 0)
  const inboxMessages = all.reduce((sum, t) => sum + t.inboxMessages, 0)
  const running = all.flatMap((t) => t.members).filter((m) => m.status === 'running').length
  const idle = all.flatMap((t) => t.members).filter((m) => m.status === 'idle').length

  // 任务表：全量按 updatedAt 降序，取最近 30 条（面板是给人扫的）
  const taskRows = all
    .flatMap((t) => t.tasks.map((task) => ({ team: t.name, task })))
    .sort((a, b) => ((b.task.updatedAt ?? 0) - (a.task.updatedAt ?? 0)))
    .slice(0, 30)

  const blocks: ViewSpec['blocks'] = [
    {
      kind: 'metrics',
      title: '分身总览',
      items: [
        { label: '在册团队', value: String(active.length), tone: active.length > 0 ? 'ok' : 'muted' },
        { label: '归档团队', value: String(archived.length), tone: 'muted' },
        { label: '成员', value: String(memberCount) },
        { label: '运行中/空闲', value: `${String(running)} / ${String(idle)}` },
        { label: '任务', value: String(taskCount) },
        { label: 'inbox 积压', value: String(inboxMessages), hint: `${String(inboxFiles)} 个文件`, tone: inboxMessages > 0 ? 'warn' : 'muted' },
      ],
    },
    {
      kind: 'table',
      title: '成员状态',
      columns: [
        { key: 'team', label: '团队' },
        { key: 'name', label: '成员' },
        { key: 'role', label: '角色' },
        { key: 'status', label: '状态' },
        { key: 'joinedAt', label: '加入' },
        { key: 'scope', label: '在册' },
      ],
      rows: all.flatMap((t) => t.members.map((m) => ({
        team: t.name,
        name: m.name ?? '—',
        role: clip(m.role, 40),
        status: m.status ?? '—',
        joinedAt: msToStamp(m.joinedAt),
        scope: t.archived ? '归档' : '在册',
      }))),
    },
    {
      kind: 'table',
      title: `任务（最近 30 条 / 共 ${String(taskCount)} 条）`,
      columns: [
        { key: 'team', label: '团队' },
        { key: 'id', label: 'id' },
        { key: 'subject', label: '主题' },
        { key: 'status', label: '状态' },
        { key: 'assignee', label: '负责人' },
        { key: 'updatedAt', label: '更新' },
      ],
      rows: taskRows.map(({ team, task }) => ({
        team,
        id: task.id ?? '—',
        subject: clip(task.subject, 70),
        status: task.status ?? '—',
        assignee: task.assignee ?? '—',
        updatedAt: msToStamp(task.updatedAt),
      })),
    },
  ]

  const lines: string[] = []
  if (all.length === 0) {
    lines.push(`未发现团队：${join(deps.workspace, '.agent-teams').replace(/\\/g, '/')} 下没有含 team.json 的目录。`)
  }
  for (const t of all) {
    lines.push(`${t.archived ? '[归档] ' : ''}${t.name}（${t.id}）· 成员 ${String(t.members.length)} · 任务 ${String(t.tasks.length)} · 队长会话 ${t.captainSessionId === '' ? '—' : t.captainSessionId}`)
    lines.push(`  说明：${clip(t.description, 160) || '（无描述）'}`)
    lines.push(`  inbox：${String(t.inboxFiles)} 个文件 / ${String(t.inboxMessages)} 条${t.inboxDetail.length > 0 ? ` — ${t.inboxDetail.join(' · ')}` : ''}`)
  }
  lines.push('数据源：`.agent-teams/<team>/team.json` + `<team>/inbox/*.jsonl`；全部只读，面板不派发任何动作。')
  blocks.push({ kind: 'text', title: '团队明细', lines })

  return { blocks }
}

/**
 * 构造「分身」面板贡献（只读，无动作）。
 * @param deps - 工作区根
 * @returns 面板贡献
 */
export function createAgentTeamsPanel(deps: AgentTeamsDeps): PanelContribution {
  return {
    id: 'agent-teams',
    title: '分身',
    order: 40,
    icon: 'users',
    description: 'AgentTeams：成员状态、任务清单与 inbox 积压（只读）',
    view: () => toAgentTeamsSpec(deps),
  }
}
