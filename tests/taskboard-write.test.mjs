/**
 * 任务板**写入通道**的语义与防线测试（离线，隔离临时工作区）。
 *
 * 核心断言（每条都对应一个真实的失效模式）：
 *   ① post 语义镜像插件：id = `t-` + 8 位、status=pending、createdAt/updatedAt 为 UTC ISO
 *   ② claim 仅限 pending、complete 仅限 claimed（错误码与插件一致：not-pending / not-claimed / task-not-found）
 *   ③ complete 之后终态被归档（完成即归档），板面只留非终态
 *   ④ **尸体测试（写入安全）**：板面解析失败时拒绝写入、**文件字节一字不改**
 *      ——只读路径可以宽容地「按空板显示」，写入路径若照抄这个宽容就会清空真实数据
 *   ⑤ **审批门**：「删除任务」声明 requiresApproval → 判定层 403 拒发（run 永不执行）；
 *      即便绕过判定层，run 自身也拒绝（两层拒绝）
 *   ⑥ 视图里列出的动作 = 贡献里可派的动作（防「显示的动作」与「可派的动作」漂移）
 *
 * 运行：node --test "tests/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boardFileOf, archiveDirOf, readBoardStrict, postTask, claimTask, completeTask,
  removeTaskRefused, taskboardActions, toTaskboardSpec, createTaskboardPanel,
} from '../lib/panels/taskboard.js'
import { decideDispatch } from '../lib/registry.js'

/** 建隔离工作区；tasks=null 表示不建板面文件（首次建板场景）。 */
function makeWorkspace(tasks) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-write-'))
  mkdirSync(join(root, '.taskboard'), { recursive: true })
  if (tasks !== null) {
    writeFileSync(join(root, '.taskboard', 'tasks.json'), JSON.stringify({ tasks }, null, 2), 'utf8')
  }
  return root
}

const NOW = new Date('2026-09-13T08:30:00.000Z')
const PENDING = { id: 't-1', title: '待办一', status: 'pending', priority: 'normal', createdAt: '2026-09-01T00:00:00.000Z' }
const CLAIMED = { id: 't-2', title: '进行中一', status: 'claimed', assignee: 'alice', createdAt: '2026-09-01T00:00:00.000Z' }

test('post：空标题拒绝，且板面一字不改', () => {
  const ws = makeWorkspace([PENDING])
  const before = readFileSync(boardFileOf({ workspace: ws }), 'utf8')
  const result = postTask({ workspace: ws }, NOW, { title: '   ' })
  assert.equal(result.ok, false)
  assert.match(result.message, /title-required/)
  assert.equal(readFileSync(boardFileOf({ workspace: ws }), 'utf8'), before, '拒绝路径必须零副作用')
})

test('post：新建 pending 任务，id/时间戳形状与插件一致', () => {
  const ws = makeWorkspace([PENDING])
  const result = postTask({ workspace: ws }, NOW, { title: '新任务', description: '说明', type: 'long', priority: 'high' })
  assert.equal(result.ok, true)
  assert.match(String(result.data.taskId), /^t-[0-9a-f]{8}$/)

  const board = JSON.parse(readFileSync(boardFileOf({ workspace: ws }), 'utf8'))
  assert.equal(board.tasks.length, 2)
  const created = board.tasks[1]
  assert.equal(created.status, 'pending')
  assert.equal(created.type, 'long')
  assert.equal(created.priority, 'high')
  assert.equal(created.createdAt, NOW.toISOString())
  assert.equal(created.updatedAt, NOW.toISOString())
  assert.deepEqual(created.tags, [])
})

test('post：板面缺失时允许建板（首次使用不是错误）', () => {
  const ws = makeWorkspace(null)
  const result = postTask({ workspace: ws }, NOW, { title: '第一条' })
  assert.equal(result.ok, true)
  const board = JSON.parse(readFileSync(boardFileOf({ workspace: ws }), 'utf8'))
  assert.equal(board.tasks.length, 1)
})

test('尸体测试：板面解析失败 → 拒绝写入，真实数据不被空板覆盖', () => {
  const ws = makeWorkspace([PENDING])
  const file = boardFileOf({ workspace: ws })
  const corrupt = '{ 这不是 JSON，而是被截断的真实数据'
  writeFileSync(file, corrupt, 'utf8')
  const before = readFileSync(file, 'utf8')

  // 只读路径宽容（按空板显示，便于人发现问题）
  assert.deepEqual(readBoardStrict(file).ok, false)
  // 写入路径苛刻：post / claim / complete 三条都必须拒绝
  for (const call of [
    () => postTask({ workspace: ws }, NOW, { title: 'x' }),
    () => claimTask({ workspace: ws }, NOW, 't-1'),
    () => completeTask({ workspace: ws }, NOW, 't-1'),
  ]) {
    const result = call()
    assert.equal(result.ok, false)
    assert.match(result.message, /拒绝写入/)
    assert.equal(readFileSync(file, 'utf8'), before, '拒绝写入必须零副作用')
  }
})

test('claim：pending → claimed（默认负责人 alice），非 pending 拒绝', () => {
  const ws = makeWorkspace([PENDING, CLAIMED])
  const ok = claimTask({ workspace: ws }, NOW, 't-1')
  assert.equal(ok.ok, true)
  const board = JSON.parse(readFileSync(boardFileOf({ workspace: ws }), 'utf8'))
  const claimed = board.tasks.find((t) => t.id === 't-1')
  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.assignee, 'alice')
  assert.equal(claimed.claimedAt, NOW.toISOString())

  const before = readFileSync(boardFileOf({ workspace: ws }), 'utf8')
  const again = claimTask({ workspace: ws }, NOW, 't-1')
  assert.equal(again.ok, false)
  assert.match(again.message, /not-pending/)
  assert.equal(readFileSync(boardFileOf({ workspace: ws }), 'utf8'), before, '拒绝路径零副作用')

  const missing = claimTask({ workspace: ws }, NOW, 't-999')
  assert.equal(missing.ok, false)
  assert.match(missing.message, /task-not-found/)
})

test('complete：claimed → done，随后终态归档（板面只留非终态）', () => {
  const ws = makeWorkspace([PENDING, CLAIMED])
  const result = completeTask({ workspace: ws }, NOW, 't-2', '做完了')
  assert.equal(result.ok, true)
  assert.equal(result.data.archiveOk, true)

  const board = JSON.parse(readFileSync(boardFileOf({ workspace: ws }), 'utf8'))
  assert.deepEqual(board.tasks.map((t) => t.id), ['t-1'], 'done 任务应被归档移出板面')
  const archive = JSON.parse(readFileSync(join(archiveDirOf({ workspace: ws }), 'terminal-2026-09-13.json'), 'utf8'))
  assert.deepEqual(archive.tasks.map((t) => t.id), ['t-2'])
  assert.equal(archive.tasks[0].summary, '做完了')
})

test('complete：pending 任务 → not-claimed，板面不变', () => {
  const ws = makeWorkspace([PENDING])
  const before = readFileSync(boardFileOf({ workspace: ws }), 'utf8')
  const result = completeTask({ workspace: ws }, NOW, 't-1')
  assert.equal(result.ok, false)
  assert.match(result.message, /not-claimed/)
  assert.equal(readFileSync(boardFileOf({ workspace: ws }), 'utf8'), before)
})

test('审批门：「删除任务」判定层 403 拒发，执行层再拒一次', () => {
  const ws = makeWorkspace([PENDING])
  const actions = taskboardActions({ workspace: ws })
  const del = actions['delete-task']
  assert.equal(del.requiresApproval, true, '删除属须请示三类，必须标 requiresApproval')
  assert.equal(del.level, 'destructive')

  const decision = decideDispatch(del, true, '任务板', { actionId: 'delete-task', params: { taskId: 't-1' }, confirm: true })
  assert.equal(decision.kind, 'requires-approval')
  assert.equal(decision.status, 403, '带 confirm=true 也必须拒绝——审批门优先于确认门')
  assert.match(String(decision.approvalHint), /面板请示/)

  // 执行层拒绝（防御纵深：判定层若被绕过，run 自身也不删）
  const direct = removeTaskRefused('t-1')
  assert.equal(direct.ok, false)
  assert.match(direct.message, /须请示三类/)
})

test('视图列出的动作 = 贡献里可派的动作（防漂移）', () => {
  const ws = makeWorkspace([PENDING])
  const spec = toTaskboardSpec({ workspace: ws })
  const block = spec.blocks.find((b) => b.kind === 'actions')
  assert.ok(block !== undefined, '任务板视图必须有动作块')
  const listed = block.items.map((i) => i.actionId).sort()
  const panel = createTaskboardPanel({ workspace: ws })
  assert.deepEqual(listed, Object.keys(panel.actions).sort())
})
