/**
 * 面板审计（只读面板）的行为测试。
 *
 * 核心断言：
 *   ① 文件缺失 = 正常初始态（ok 视图 + 说明），不是错误
 *   ② 坏行（半截 JSON / 非 JSON）逐行跳过并计数，不因一行坏而整页失败
 *   ③ limit 参数边界：非法 → 默认；越界 → 夹到 500
 *   ④ 文件超过 512KB → 只读尾部并**如实标注截断**（诚实优先于好看）
 *   ⑤ 只读面板没有动作（审计是证据，不提供改写通道）
 *
 * 运行：node --test "tests/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAudit, parseLimit, auditFileOf, toAuditSpec, createAuditPanel } from '../lib/panels/audit.js'

/** 建隔离审计目录。 */
function makePanelDir() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-audit-'))
  mkdirSync(join(root, 'panel'), { recursive: true })
  return join(root, 'panel')
}

/** 造一条审计记录。 */
function record(at, outcome, extra = {}) {
  return JSON.stringify({ at, panelId: 'taskboard', actionId: 'claim', level: 'write', paramsDigest: 'abc123', outcome, durationMs: 3, ...extra })
}

test('文件缺失：正常初始态——ok 视图 + 明示来源，不报错', () => {
  const dir = makePanelDir()
  const spec = toAuditSpec({ panelDir: dir })
  const text = spec.blocks.find((b) => b.kind === 'text')
  assert.ok(text.lines.some((l) => l.includes('audit.jsonl')))
  const metrics = spec.blocks.find((b) => b.kind === 'metrics')
  assert.equal(metrics.items[0].value, '0')
  assert.equal(auditFileOf({ panelDir: dir }).endsWith('audit.jsonl'), true)
})

test('坏行逐行跳过并计数，好行照常展示', () => {
  const dir = makePanelDir()
  const file = auditFileOf({ panelDir: dir })
  writeFileSync(file, [
    record('2026-09-13T08:00:00.000Z', 'ok'),
    '{半截 JSON',
    record('2026-09-13T08:01:00.000Z', 'denied', { reason: 'requires-approval', message: '须请示' }),
    '不是 JSON 的纯文本',
    '',
    record('2026-09-13T08:02:00.000Z', 'error', { message: '写入失败' }),
  ].join('\n') + '\n', 'utf8')

  const { records, corrupt } = readAudit(file, 100)
  assert.equal(records.length, 3)
  assert.equal(corrupt, 2)

  const spec = toAuditSpec({ panelDir: dir })
  const metrics = spec.blocks.find((b) => b.kind === 'metrics')
  const valueOf = (label) => metrics.items.find((i) => i.label === label).value
  assert.equal(valueOf('成功'), '1')
  assert.equal(valueOf('被拒'), '1')
  assert.equal(valueOf('失败'), '1')
  const table = spec.blocks.find((b) => b.kind === 'table')
  assert.equal(table.rows[0].at, '2026-09-13 08:02:00', '最新一条排在最前')
  assert.equal(table.rows[0].panel, 'taskboard')
})

test('limit 参数：非法 → 默认，越界 → 夹到 500，正常 → 取最后 N 条', () => {
  assert.equal(parseLimit(undefined), 100)
  assert.equal(parseLimit('abc'), 100)
  assert.equal(parseLimit('0'), 100)
  assert.equal(parseLimit('-3'), 100)
  assert.equal(parseLimit('9999'), 500)
  assert.equal(parseLimit('7'), 7)

  const dir = makePanelDir()
  const file = auditFileOf({ panelDir: dir })
  const lines = []
  for (let i = 0; i < 10; i++) lines.push(record(`2026-09-13T08:0${String(i)}:00.000Z`, 'ok'))
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  const { records } = readAudit(file, 3)
  assert.equal(records.length, 3)
  assert.equal(records[2].at, '2026-09-13T08:09:00.000Z')
})

test('超过 512KB → 只读尾部 + 如实标注截断', () => {
  const dir = makePanelDir()
  const file = auditFileOf({ panelDir: dir })
  const line = record('2026-09-13T08:00:00.000Z', 'ok', { message: 'x'.repeat(200) })
  const chunk = []
  for (let i = 0; i < 4000; i++) chunk.push(line)
  writeFileSync(file, chunk.join('\n') + '\n', 'utf8')

  const result = readAudit(file, 5)
  assert.equal(result.truncated, true)
  assert.equal(result.records.length, 5)
  assert.ok(result.records.every((r) => r.outcome === 'ok'))

  const spec = toAuditSpec({ panelDir: dir, limit: '5' })
  const text = spec.blocks.find((b) => b.kind === 'text')
  assert.ok(text.lines.some((l) => l.includes('只读尾部') || l.includes('截断')), '必须标注只覆盖尾部')
})

test('只读面板：不声明任何动作', () => {
  const panel = createAuditPanel({ panelDir: makePanelDir() })
  assert.equal(panel.id, 'audit')
  assert.equal(panel.actions, undefined, '审计是证据——不得提供任何改写通道')
  assert.equal(typeof panel.view, 'function')
})
