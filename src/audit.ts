/**
 * audit.ts — 动作审计（谁在什么时候对哪个面板做了什么，结果如何）
 *
 * 语义文档 §4.3 [MUST]：每次派发写一条 `DSH_HOME/panel/audit.jsonl`。
 * 纪律：**paramsDigest 只存哈希，不存原值**（凭据不落盘），但 message/error 保留人读文本。
 * 失败不抛错（审计故障不得让动作本身失败），但必须在返回值里如实标记。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 一条审计记录。 */
export interface AuditRecord {
  at: string
  panelId: string
  actionId: string
  level: string
  /** 参数哈希（sha256 前 16 位十六进制）；无参数为 null。 */
  paramsDigest: string | null
  outcome: 'ok' | 'error' | 'denied' | 'timeout'
  reason?: string
  durationMs: number
  message?: string
  sessionId?: string
}

/** 计算参数摘要（稳定序列化 → sha256 → 截断）。 */
export function digestParams(params: unknown): string | null {
  if (params === undefined || params === null) return null
  const keys = typeof params === 'object' && !Array.isArray(params) ? Object.keys(params as object).sort() : []
  if (keys.length === 0) return null
  const stable = JSON.stringify(params, keys.length > 0 ? keys : undefined)
  return createHash('sha256').update(stable).digest('hex').slice(0, 16)
}

/**
 * 追加一条审计记录。
 * @param dir - 审计目录（`DSH_HOME/panel`）
 * @returns 写入是否成功（false = 审计故障，调用方应如实上报但不必中断动作）
 */
export function appendAudit(dir: string, record: AuditRecord): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'audit.jsonl'), JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}
