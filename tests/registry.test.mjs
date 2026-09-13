/**
 * registry.test.mjs — 宿主防线判定的离线单测（纯函数，无 IO）
 *
 * 覆盖语义文档 §9 的 #4/#5/#6/#7 与 §4.5 的健康推导：
 *   重名/非法 id 必须 fail-loud；未知面板/动作零副作用；审批门优先于确认门；缺确认拒绝破坏性动作；
 *   参数白名单过滤；健康度由实测样本推导（unknown → ok → degraded → down → ok）。
 * 运行：node tests/registry.test.mjs（在插件根目录；需先 pnpm build）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PanelRegistry, computeHealth, decideDispatch, emptySnapshot, isValidPanelId, sanitizeParams, actionItems,
} from '../lib/registry.js'
import { digestParams } from '../lib/audit.js'

const NOW = '2026-09-12T13:00:00.000Z'

/** 造一份最小贡献。 */
function contribution(over = {}) {
  return {
    id: 'demo',
    title: '演示',
    view: () => ({ blocks: [] }),
    ...over,
  }
}

test('isValidPanelId: 只接受小写字母/数字/连字符，且不以连字符开头', () => {
  assert.equal(isValidPanelId('plugin-manager'), true)
  assert.equal(isValidPanelId('a1'), true)
  assert.equal(isValidPanelId('-bad'), false)
  assert.equal(isValidPanelId('Bad'), false)
  assert.equal(isValidPanelId('has space'), false)
  assert.equal(isValidPanelId(''), false)
})

test('computeHealth: 无样本 unknown → 成功 ok → 慢 degraded → 一次失败 degraded → 连续两次 down', () => {
  assert.equal(computeHealth(0, 0, null), 'unknown')
  assert.equal(computeHealth(1, 0, 12), 'ok')
  assert.equal(computeHealth(2, 0, 1500), 'degraded') // 慢响应
  assert.equal(computeHealth(3, 1, 12), 'degraded')
  assert.equal(computeHealth(4, 2, 12), 'down')
  assert.equal(computeHealth(4, 7, 12), 'down')
  assert.equal(computeHealth(5, 0, 900), 'ok') // 恢复后回到 ok
})

test('sanitizeParams: 未声明的键一律丢弃，类型不符即拒绝', () => {
  const spec = { name: 'string', count: 'number', flag: 'boolean' }
  const ok = sanitizeParams(spec, { name: 'x', count: 3, flag: true, sneaky: 'drop-me' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.params, { name: 'x', count: 3, flag: true })
  assert.equal(Object.hasOwn(ok.params, 'sneaky'), false)
  assert.equal(sanitizeParams(spec, { count: '3' }).ok, false)
  assert.equal(sanitizeParams(spec, [1, 2]).ok, false)
  assert.equal(sanitizeParams(undefined, { anything: 1 }).ok, true)
  assert.deepEqual(sanitizeParams(undefined, { anything: 1 }).params, {})
})

test('decideDispatch: 未场面板/未知动作 → 404（零副作用）', () => {
  const a = decideDispatch(undefined, false, '演示', { actionId: 'x' })
  assert.equal(a.kind, 'unknown-panel')
  assert.equal(a.status, 404)
  const b = decideDispatch(undefined, true, '演示', { actionId: 'x' })
  assert.equal(b.kind, 'unknown-action')
  assert.equal(b.status, 404)
})

test('decideDispatch: 审批门（须请示三类）优先于确认门——即使带 confirm 也拒绝', () => {
  const action = { label: '清空记忆库', level: 'destructive', requiresApproval: true, run: () => ({ ok: true }) }
  for (const confirm of [undefined, false, true]) {
    const d = decideDispatch(action, true, '记忆', { actionId: 'wipe', confirm })
    assert.equal(d.kind, 'requires-approval', 'confirm=' + String(confirm))
    assert.equal(d.status, 403)
    assert.match(d.approvalHint, /面板请示/)
  }
})

test('decideDispatch: 破坏性动作缺确认 → 409；带确认 → 放行', () => {
  const action = { label: '删除', level: 'destructive', run: () => ({ ok: true }) }
  const denied = decideDispatch(action, true, '演示', { actionId: 'del' })
  assert.equal(denied.kind, 'confirm-required')
  assert.equal(denied.status, 409)
  const allowed = decideDispatch(action, true, '演示', { actionId: 'del', confirm: true })
  assert.equal(allowed.kind, 'run')
  assert.equal(allowed.status, 200)
})

test('decideDispatch: 参数非法 → 400；只读/写入动作无需确认', () => {
  const action = { label: '改名', level: 'write', params: { name: 'string' }, run: () => ({ ok: true }) }
  assert.equal(decideDispatch(action, true, '演示', { actionId: 'r', params: { name: 7 } }).kind, 'bad-params')
  assert.equal(decideDispatch(action, true, '演示', { actionId: 'r', params: { name: 'ok' } }).kind, 'run')
  assert.equal(decideDispatch(action, true, '演示', { actionId: 'r' }).kind, 'run')
})

test('PanelRegistry: 非法 id / 重复 id fail-loud；dispose 后消失；list 按 order 排序', () => {
  const reg = new PanelRegistry()
  assert.throws(() => reg.register(contribution({ id: 'Bad Id' }), NOW), /illegal id/)
  const disposeA = reg.register(contribution({ id: 'aaa', title: 'A', order: 20 }), NOW)
  reg.register(contribution({ id: 'bbb', title: 'B', order: 10 }), NOW)
  assert.throws(() => reg.register(contribution({ id: 'aaa', title: 'A2' }), NOW), /duplicate panel id/)
  assert.deepEqual(reg.list().map((p) => p.id), ['bbb', 'aaa'])
  assert.deepEqual(reg.list()[1].health, 'unknown')
  disposeA()
  assert.deepEqual(reg.list().map((p) => p.id), ['bbb'])
})

test('PanelRegistry: recordView 驱动健康度迁移（含恢复）', () => {
  const reg = new PanelRegistry()
  reg.register(contribution({ id: 'x' }), NOW)
  assert.equal(reg.get('x').snapshot.health, 'unknown')
  reg.recordView('x', true, 10, null, NOW)
  assert.equal(reg.get('x').snapshot.health, 'ok')
  assert.equal(reg.get('x').snapshot.lastOkAt, NOW)
  reg.recordView('x', false, 2005, '取数超时（>2000ms）', NOW)
  assert.equal(reg.get('x').snapshot.health, 'degraded')
  assert.match(reg.get('x').snapshot.lastError, /超时/)
  assert.equal(reg.get('x').snapshot.lastOkAt, NOW, '失败不清除历史成功时刻')
  reg.recordView('x', false, 20, 'boom', NOW)
  assert.equal(reg.get('x').snapshot.health, 'down')
  reg.recordView('x', true, 20, null, NOW)
  assert.equal(reg.get('x').snapshot.health, 'ok')
  assert.equal(reg.get('x').snapshot.lastError, null, '恢复后清空错误')
})

test('PanelRegistry: unknown 面板的 recordView 是 no-op（不崩）', () => {
  const reg = new PanelRegistry()
  reg.recordView('ghost', true, 1, null, NOW)
  assert.deepEqual(reg.health(), [])
})

test('emptySnapshot / actionItems: 形状契约', () => {
  assert.deepEqual(emptySnapshot(), { health: 'unknown', lastOkAt: null, lastError: null, lastDurationMs: null, sampleCount: 0 })
  assert.deepEqual(actionItems(undefined), [])
  assert.deepEqual(
    actionItems({ del: { label: '删除', level: 'destructive', run: () => ({ ok: true }) } }),
    [{ actionId: 'del', label: '删除', level: 'destructive' }],
  )
})

test('digestParams: 无参数 → null；键序无关（同摘要）；有参数 → 16 位十六进制', () => {
  assert.equal(digestParams(undefined), null)
  assert.equal(digestParams({}), null)
  const a = digestParams({ b: 1, a: 'x' })
  const b = digestParams({ a: 'x', b: 1 })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, digestParams({ a: 'x', b: 2 }))
})
