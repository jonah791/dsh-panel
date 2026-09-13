/**
 * panels/audit.ts — 内置面板：面板审计（只读）
 *
 * 数据源：`<DSH_HOME>/panel/audit.jsonl` —— 宿主每次派发的记录（见 `src/audit.ts`）。
 * 只读面板（无动作）：审计是**证据**，面板不提供任何改写审计的通道（篡改证据比没有证据更坏）。
 *
 * 纪律：
 *   - 参数只认 `limit`（1..500，默认 100），其余一律忽略——与宿主 `params` 白名单同精神；
 *   - 文件超大时**只读尾部**并如实标注「已截断」，不假装读全（诚实优先于好看）；
 *   - 坏行（半截 JSON、非 JSON）逐行跳过并计数，不因一行坏而整页失败；
 *   - `paramsDigest` 只展示哈希（原值从不落盘，见 audit.ts）。
 * @module dsh-panel/panels/audit
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditRecord } from '../audit.ts'
import type { PanelContribution, Tone, ViewSpec } from '../types.ts'

/** 面板依赖：审计目录（`DSH_HOME/panel`）。 */
export interface AuditDeps {
  /** 审计目录。 */
  panelDir: string
}

/** 默认展示条数。 */
const DEFAULT_LIMIT = 100
/** 上限（防止一次请求把日志整页灌进浏览器）。 */
const MAX_LIMIT = 500
/** 超过该体积只读尾部（字节）。 */
const TAIL_BYTES = 512 * 1024

/** 审计文件路径。 */
export function auditFileOf(deps: AuditDeps): string {
  return join(deps.panelDir, 'audit.jsonl')
}

/** 解析 `limit` 参数（非法/越界 → 默认值；不做静默截断以外的事）。 */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

/**
 * 读取审计记录（从旧到新）。文件缺失 = 正常初始态（不是错误）。
 * @param file - audit.jsonl 路径
 * @param limit - 取最后 N 条
 * @returns 记录、坏行数、是否因体积截断、原始字节数
 */
export function readAudit(file: string, limit: number): { records: AuditRecord[]; corrupt: number; truncated: boolean; bytes: number } {
  if (!existsSync(file)) return { records: [], corrupt: 0, truncated: false, bytes: 0 }
  let bytes = 0
  let raw: string
  let truncated = false
  try {
    bytes = statSync(file).size
  } catch {
    return { records: [], corrupt: 0, truncated: false, bytes: 0 }
  }
  try {
    if (bytes > TAIL_BYTES) {
      const fd = openSync(file, 'r')
      try {
        const size = TAIL_BYTES
        const buffer = Buffer.allocUnsafe(size)
        readSync(fd, buffer, 0, size, bytes - size)
        raw = buffer.toString('utf8')
      } finally {
        closeSync(fd)
      }
      truncated = true
      // 尾部读取很可能从半截行开始：丢掉第一段（不可信），坏行计数不把它算作坏行
      const firstBreak = raw.indexOf('\n')
      raw = firstBreak >= 0 ? raw.slice(firstBreak + 1) : ''
    } else {
      raw = readFileSync(file, 'utf8')
    }
  } catch {
    return { records: [], corrupt: 0, truncated: false, bytes }
  }

  const records: AuditRecord[] = []
  let corrupt = 0
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const parsed = JSON.parse(text) as AuditRecord
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.at !== 'string') {
        corrupt += 1
        continue
      }
      records.push(parsed)
    } catch {
      corrupt += 1
    }
  }
  return { records: records.slice(-limit), corrupt, truncated, bytes }
}

/** outcome → tone。 */
function toneOf(outcome: string): Tone {
  if (outcome === 'ok') return 'ok'
  if (outcome === 'denied') return 'warn'
  return 'bad'
}

/**
 * 把审计日志编译成视图规格。
 * @param deps - 审计目录
 * @param params - 取数参数（只认 limit）
 */
export function toAuditSpec(deps: AuditDeps, params: Record<string, string> = {}): ViewSpec {
  const file = auditFileOf(deps)
  const limit = parseLimit(params.limit)
  const { records, corrupt, truncated, bytes } = readAudit(file, limit)

  const counts: Record<string, number> = { ok: 0, denied: 0, error: 0, timeout: 0 }
  for (const r of records) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
  const newest = records[records.length - 1]

  const lines: string[] = []
  lines.push(`审计文件：${file.replace(/\\/g, '/')}（${String(bytes)} 字节${truncated ? '，本次只读尾部 512KB' : ''}）`)
  lines.push(`本次展示：最近 ${String(records.length)} 条（上限 ${String(limit)}）${corrupt > 0 ? ` · 跳过坏行 ${String(corrupt)} 行` : ''}`)
  if (truncated) lines.push('⚠ 文件超过 512KB：本页只覆盖尾部，早期记录未展示（如需全量请直接读文件）。')
  lines.push('语义：paramsDigest 是参数哈希（原值从不落盘）；denied = 判定层拒绝（零副作用）；error/timeout = 动作执行失败。')
  lines.push('只读面板：审计是证据，面板不提供任何改写审计的通道。')

  return {
    blocks: [
      {
        kind: 'metrics',
        title: '审计总览（本次窗口）',
        items: [
          { label: '成功', value: String(counts.ok ?? 0), tone: 'ok' },
          { label: '被拒', value: String(counts.denied ?? 0), tone: (counts.denied ?? 0) > 0 ? 'warn' : 'muted' },
          { label: '失败', value: String(counts.error ?? 0), tone: (counts.error ?? 0) > 0 ? 'bad' : 'muted' },
          { label: '超时', value: String(counts.timeout ?? 0), tone: (counts.timeout ?? 0) > 0 ? 'bad' : 'muted' },
          // 值只放动作名：指标卡是窄容器，`panelId·actionId` 这种长串会在卡里被硬断
          // 成两行（视觉复核 2026-09-13 实测）——面板侧先短化，面板 id 移到 hint。
          { label: '最近一次', value: newest === undefined ? '—' : newest.actionId, ...(newest === undefined ? {} : { hint: newest.panelId }) },
        ],
      },
      {
        kind: 'chart',
        title: '结果分布（本次窗口）',
        chart: 'donut',
        series: [
          { label: '成功', value: counts.ok ?? 0, tone: 'ok' },
          { label: '被拒', value: counts.denied ?? 0, tone: 'warn' },
          { label: '失败', value: counts.error ?? 0, tone: 'bad' },
          { label: '超时', value: counts.timeout ?? 0, tone: 'bad' },
        ],
      },
      {
        kind: 'table',
        title: '最近派发记录',
        columns: [
          { key: 'at', label: '时刻' },
          { key: 'panel', label: '面板' },
          { key: 'action', label: '动作' },
          { key: 'level', label: '分级' },
          { key: 'outcome', label: '结果' },
          { key: 'durationMs', label: '耗时(ms)', align: 'right' },
          { key: 'detail', label: '说明' },
        ],
        rows: records.slice().reverse().map((r) => ({
          at: r.at.slice(0, 19).replace('T', ' '),
          panel: r.panelId,
          action: r.actionId,
          level: r.level,
          outcome: r.outcome,
          durationMs: r.durationMs,
          detail: (r.reason ?? r.message ?? '').slice(0, 100),
        })),
      },
      {
        kind: 'log',
        title: `原始尾巴（最近 ${String(Math.min(records.length, 30))} 条）`,
        lines: records.slice(-30).map((r) => ({
          at: r.at.slice(11, 19),
          level: r.outcome === 'ok' ? 'ok' : (r.outcome === 'denied' ? 'warn' : 'error'),
          text: `${r.panelId}·${r.actionId} [${r.level}] ${r.outcome} ${String(r.durationMs)}ms`
            + (r.paramsDigest === null ? '' : ` #${r.paramsDigest}`)
            + (r.reason === undefined ? '' : ` (${r.reason})`)
            + (r.message === undefined || r.message === '' ? '' : ` — ${r.message}`),
        })),
      },
      { kind: 'text', title: '来源与口径', lines },
    ],
  }
}

/**
 * 构造「面板审计」面板贡献（只读）。
 * @param deps - 审计目录
 */
export function createAuditPanel(deps: AuditDeps): PanelContribution {
  return {
    id: 'audit',
    title: '面板审计',
    order: 50,
    icon: 'history',
    description: '面板宿主的派发审计日志（谁在何时对哪个面板做了什么、结果如何）；只读，不提供改写通道',
    style: { accent: '#a78bfa' },
    view: (params) => toAuditSpec(deps, params),
  }
}

/** 供测试引用的 tone 映射（避免测试重复实现判定）。 */
export const __toneOf = toneOf
