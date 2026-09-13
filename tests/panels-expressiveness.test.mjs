/**
 * 表现力扩展块在真实面板里的用法（防"契约有了但没人用"）。
 *
 * 断言的是**面板产出的规格**（不是渲染结果——渲染结果由无头浏览器验收）：
 *   · taskboard 用 tabs 分页、用 form 暴露写入动作、每个 form 的 actionId 都必须真实存在
 *   · audit 用 chart 画结果分布、用 log 出原始尾巴（严重度着色标签合法）
 *   · 面板自带 style（accent/density）符合契约
 *
 * 运行：node --test "tests/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskboardPanel } from '../lib/panels/taskboard.js'
import { createAuditPanel } from '../lib/panels/audit.js'
import { validateViewSpec } from '../lib/registry.js'

function makeWorkspace(tasks) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-express-'))
  mkdirSync(join(root, '.taskboard'), { recursive: true })
  writeFileSync(join(root, '.taskboard', 'tasks.json'), JSON.stringify({ tasks }, null, 2), 'utf8')
  return root
}

function walkBlocks(blocks, visit) {
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    visit(block)
    if (Array.isArray(block.blocks)) walkBlocks(block.blocks, visit)
    if (Array.isArray(block.items)) {
      for (const item of block.items) {
        if (item && typeof item === 'object' && Array.isArray(item.blocks)) walkBlocks(item.blocks, visit)
      }
    }
  }
}

test('taskboard：tabs 分页 + 三个 form 的 actionId 必须存在于动作表', () => {
  const ws = makeWorkspace([
    { id: 't-1', title: '待办一', status: 'pending', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 't-2', title: '进行中一', status: 'claimed', createdAt: '2026-09-01T00:00:00.000Z' },
  ])
  const panel = createTaskboardPanel({ workspace: ws })
  const spec = panel.view({})
  assert.deepEqual(validateViewSpec(spec), { ok: true }, '面板规格必须通过宿主校验')

  const tabs = spec.blocks.filter((b) => b.kind === 'tabs')
  assert.equal(tabs.length, 1)
  assert.deepEqual(tabs[0].items.map((i) => i.label), ['概览', '写操作', '来源与归档'])

  const forms = []
  const kinds = new Set()
  walkBlocks(spec.blocks, (b) => {
    kinds.add(b.kind)
    if (b.kind === 'form') forms.push(b)
  })
  assert.equal(forms.length, 3, '新建 / 认领 / 完成 三个表单')
  for (const form of forms) {
    assert.ok(Object.prototype.hasOwnProperty.call(panel.actions, form.actionId),
      `form.actionId=${form.actionId} 必须真实存在，否则按钮只会给出"元信息缺失"提示`)
    assert.ok(form.fields.length > 0)
  }
  for (const kind of ['metrics', 'chart', 'progress', 'table']) {
    assert.ok(kinds.has(kind), `概览页应包含 ${kind}`)
  }
})

test('taskboard：面板自带视觉（accent + 紧凑密度）', () => {
  const panel = createTaskboardPanel({ workspace: makeWorkspace([]) })
  assert.match(panel.style.accent, /^#[0-9a-fA-F]{6}$/)
  assert.equal(panel.style.density, 'compact')
})

test('audit：chart 结果分布 + log 原始尾巴（等级标签合法）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-express-audit-'))
  mkdirSync(join(root, 'panel'), { recursive: true })
  const file = join(root, 'panel', 'audit.jsonl')
  const rows = [
    { at: '2026-09-13T09:00:00.000Z', panelId: 'taskboard', actionId: 'post', level: 'write', paramsDigest: 'aaaa1111', outcome: 'ok', durationMs: 4 },
    { at: '2026-09-13T09:01:00.000Z', panelId: 'taskboard', actionId: 'delete-task', level: 'destructive', paramsDigest: null, outcome: 'denied', reason: 'requires-approval', durationMs: 0 },
    { at: '2026-09-13T09:02:00.000Z', panelId: 'taskboard', actionId: 'post', level: 'write', paramsDigest: null, outcome: 'error', message: '标题不能为空', durationMs: 1 },
  ]
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const spec = createAuditPanel({ panelDir: join(root, 'panel') }).view({})
  assert.deepEqual(validateViewSpec(spec), { ok: true })

  const chart = spec.blocks.find((b) => b.kind === 'chart')
  assert.equal(chart.chart, 'donut')
  assert.deepEqual(chart.series.map((s) => [s.label, s.value]), [['成功', 1], ['被拒', 1], ['失败', 1], ['超时', 0]])

  const log = spec.blocks.find((b) => b.kind === 'log')
  assert.equal(log.lines.length, 3)
  assert.deepEqual(log.lines.map((l) => l.level), ['ok', 'warn', 'error'], '严重度映射：ok / denied→warn / error')
  assert.match(log.lines[0].text, /taskboard·post \[write\] ok 4ms #aaaa1111/)
  assert.match(log.lines[1].text, /\(requires-approval\)/)
})
