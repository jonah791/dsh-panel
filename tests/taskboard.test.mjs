/**
 * taskboard 面板的动作语义测试（离线，无 IO 到真实工作区）。
 *
 * 核心断言：`archiveTerminal()` 与 `scripts/taskboard-archive-terminal.py` **同语义**——
 *   ① 终态（done/cancelled）按 id 去重追加进当日 archive/terminal-<日期>.json
 *   ② 板面随后只保留非终态项
 *   ③ **归档写失败即中止，板面一字不改**（尸体测试：把 archive 造成文件，使 mkdir 失败）
 *   ④ 归档文件损坏 → 另存 .corrupt-<HHMMSS> 后重建，不静默丢历史
 *
 * 运行：node --test "tests/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveTerminal, boardFileOf, archiveDirOf, readBoard, listArchives, createTaskboardPanel } from '../lib/panels/taskboard.js'

/** 建一个隔离的临时工作区，返回 `<tmp>/.taskboard` 所在的工作区根。 */
function makeWorkspace(tasks) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-tb-'))
  mkdirSync(join(root, '.taskboard'), { recursive: true })
  writeFileSync(join(root, '.taskboard', 'tasks.json'), JSON.stringify({ tasks }, null, 2), 'utf8')
  return root
}

const PENDING = { id: 't-1', title: '待办一', status: 'pending', priority: 'normal', createdAt: '2026-09-01T00:00:00' }
const CLAIMED = { id: 't-2', title: '进行中一', status: 'claimed', assignee: 'alice', createdAt: '2026-09-01T00:00:00' }
const DONE = { id: 't-3', title: '已完成一', status: 'done', createdAt: '2026-09-01T00:00:00' }
const CANCELLED = { id: 't-4', title: '已取消一', status: 'cancelled', createdAt: '2026-09-01T00:00:00' }

const NOW = new Date(2026, 8, 13, 15, 39, 6) // 本地时间 2026-09-13 15:39:06

test('归档终态：终态进归档文件、板面只剩非终态', () => {
  const ws = makeWorkspace([PENDING, CLAIMED, DONE, CANCELLED])
  const result = archiveTerminal({ workspace: ws }, NOW)
  assert.equal(result.ok, true)
  assert.equal(result.data.archived, 2)
  assert.equal(result.data.kept, 2)

  const board = readBoard(boardFileOf({ workspace: ws }))
  assert.deepEqual(board.tasks.map((t) => t.id), ['t-1', 't-2'])

  const archiveFile = join(archiveDirOf({ workspace: ws }), 'terminal-2026-09-13.json')
  const archive = JSON.parse(readFileSync(archiveFile, 'utf8'))
  assert.deepEqual(archive.tasks.map((t) => t.id), ['t-3', 't-4'])
  assert.equal(archive.archivedAt, '2026-09-13T15:39:06')
  assert.match(archive.note, /任务板终态归档/)
})

test('按 id 去重：重复归档同一任务不产生重复条目', () => {
  const ws = makeWorkspace([DONE])
  assert.equal(archiveTerminal({ workspace: ws }, NOW).ok, true)
  // 把同一 id 的终态任务重新放回板面，再次归档
  writeFileSync(boardFileOf({ workspace: ws }), JSON.stringify({ tasks: [{ ...DONE, title: '已完成一（改名）' }] }, null, 2), 'utf8')
  const second = archiveTerminal({ workspace: ws }, NOW)
  assert.equal(second.ok, true)
  assert.equal(second.data.archived, 1)
  assert.equal(second.data.total, 1, '同一 id 不得重复入档')

  const archive = JSON.parse(readFileSync(join(archiveDirOf({ workspace: ws }), 'terminal-2026-09-13.json'), 'utf8'))
  assert.equal(archive.tasks.length, 1)
  assert.equal(archive.tasks[0].title, '已完成一', '已入档条目不被覆盖')
})

test('无可归档项：ok 且不创建归档文件', () => {
  const ws = makeWorkspace([PENDING, CLAIMED])
  const before = readFileSync(boardFileOf({ workspace: ws }), 'utf8')
  const result = archiveTerminal({ workspace: ws }, NOW)
  assert.equal(result.ok, true)
  assert.equal(result.data.archived, 0)
  assert.equal(readFileSync(boardFileOf({ workspace: ws }), 'utf8'), before)
  assert.deepEqual(listArchives(archiveDirOf({ workspace: ws })), [])
})

test('尸体测试：归档写失败 → ok=false 且板面一字不改', () => {
  const ws = makeWorkspace([PENDING, DONE])
  const before = readFileSync(boardFileOf({ workspace: ws }), 'utf8')
  // 把 archive 造成**文件**（不是目录）：mkdirSync 必然失败 → 归档路径不可写
  writeFileSync(join(ws, '.taskboard', 'archive'), 'not a directory', 'utf8')
  const result = archiveTerminal({ workspace: ws }, NOW)
  assert.equal(result.ok, false, '归档失败必须如实报错')
  assert.match(result.message, /归档失败，板面未改动/)
  assert.equal(readFileSync(boardFileOf({ workspace: ws }), 'utf8'), before, '板面必须一字不改')
})

test('归档文件损坏 → 另存 .corrupt-<HHMMSS> 后重建', () => {
  const ws = makeWorkspace([DONE])
  const dir = archiveDirOf({ workspace: ws })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'terminal-2026-09-13.json'), '{ this is not json', 'utf8')
  const result = archiveTerminal({ workspace: ws }, NOW)
  assert.equal(result.ok, true)
  assert.equal(result.data.total, 1)
  const corrupt = join(dir, 'terminal-2026-09-13.json.corrupt-153906')
  assert.equal(readFileSync(corrupt, 'utf8'), '{ this is not json', '损坏原文件必须另存而非丢弃')
})

test('动作表与视图契约：id/order/动作分级', () => {
  const ws = makeWorkspace([PENDING])
  const panel = createTaskboardPanel({ workspace: ws })
  assert.equal(panel.id, 'taskboard')
  assert.equal(panel.order, 20)
  assert.equal(panel.actions['archive-terminal'].level, 'write')
})
