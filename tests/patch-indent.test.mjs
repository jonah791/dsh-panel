/**
 * patch-indent.test.mjs — patchSetDisabled 写出的 patch 必须是**能被解析的 YAML**
 *
 * 事故（2026-11-12，由全域缩进硬编码扫描发现）：
 * `src/panels/plugin-manager.ts` 把 `disabled:` 行的缩进写死成 8 个空格。而本 profile 的真实
 * 结构是：
 *
 *     - insert:
 *         - id: ds-harness-remote      ← `-` 缩进 4
 *           name: 'ds-harness-remote'  ← 兄弟键缩进 6（= dashIndent + 2）
 *
 * 8 空格比兄弟键深 2 级 ⇒ 写出的 patch 是**非法 YAML**（PyYAML 报
 * `ScannerError: mapping values are not allowed here`），而函数照样返回 `{ok: true}`。
 * 这正是「看起来成功」的失败，和 2026-11-02 那个 `length <= 2` 同族。
 *
 * ⇒ 判据不能是「返回了 ok」（旧实现也满足），必须是「写出的文件结构合法」。
 *   本文件的自检器不依赖外部 YAML 库，直接校验**列表项的直接子键必须共享同一缩进**——
 *   这正是 8 空格违约的形状；且带上「config 内同名键不算兄弟键」的反向对照。
 *
 * 运行：node --test "tests/*.test.mjs"（跑 lib/ 产物 ⇒ 需先 npm run build）
 * 夹具纪律：全部在 os.tmpdir 下的临时目录，不碰生产 patch。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchSetDisabled } from '../lib/panels/plugin-manager.js'

const indentOf = (l) => (/^(\s*)/.exec(l) ?? ['', ''])[1].length

/**
 * 极简 YAML 结构自检：每个列表项（`- id:` 开头的行）的**直接子键必须共享同一缩进**。
 * 只覆盖本函数会写的那种结构（块状 list-of-maps），但足以区分「6 空格」与「8 空格」——
 * 8 空格没有更浅的父键可以归属，任何严格解析器都会拒。
 * @returns {string[]} 违规说明（空数组 = 结构合法）
 */
function structuralIssues(text) {
  const lines = text.split(/\r?\n/)
  const issues = []
  for (let i = 0; i < lines.length; i += 1) {
    const idMatch = /^(\s*)-\s*id:/.exec(lines[i])
    if (!idMatch) continue
    const siblingIndent = idMatch[1].length + 2
    // 收集本列表项的直接子键（缩进 == dashIndent + 2 的 `key:` 行）

    for (let j = i + 1; j < lines.length; j += 1) {
      const raw = lines[j]
      const t = raw.trim()
      if (t === '' || t.startsWith('#')) continue
      if (indentOf(raw) < siblingIndent) break
      if (/^-\s/.test(t) && indentOf(raw) === idMatch[1].length) break
      if (indentOf(raw) === siblingIndent) continue
      // 缩进比兄弟键深：必须有能开块的父行（以 ':' 或 '-' 结尾），否则非法
      const prev = lines[j - 1]?.trim() ?? ''
      if (!/[:|-]$/.test(prev) && !/^\[$/.test(prev) && !prev.startsWith('#')) {
        issues.push(`第 ${j + 1} 行缩进 ${indentOf(raw)}（兄弟键应为 ${siblingIndent}），父行「${prev}」不能开块`)
        break
      }
    }
  }
  return issues
}

/** 建一个临时 patch 文件，返回路径与清理函数。 */
function fixture(text) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-patch-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, text, 'utf8')
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const INSERT_SHAPE = [
  '- insert:',
  '    - id: ds-harness-remote',
  "      name: 'ds-harness-remote'",
  '      inject: [ webServer ]',
  '',
].join('\n')

test('插入新行：`- insert:` 容器内应写成兄弟键缩进 6，不是写死 8', () => {
  const { file, cleanup } = fixture(INSERT_SHAPE)
  try {
    const r = patchSetDisabled(file, 'ds-harness-remote', false)
    assert.equal(r.ok, true, `返回失败：${r.error}`)
    const out = readFileSync(file, 'utf8')
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('disabled:'))
    assert.ok(line, '没有写出 disabled 行')
    assert.equal(indentOf(line), 6, `disabled 缩进应为 6（dashIndent 4 + 2），实得 ${indentOf(line)}`)
    assert.deepEqual(structuralIssues(out), [], '写出的 patch 结构非法')
  } finally {
    cleanup()
  }
})

test('改已有行：保持在兄弟键缩进，不把整行推到 8 空格', () => {
  const src = INSERT_SHAPE.replace(
    "      name: 'ds-harness-remote'",
    "      name: 'ds-harness-remote'\n      disabled: false",
  )
  const { file, cleanup } = fixture(src)
  try {
    assert.equal(patchSetDisabled(file, 'ds-harness-remote', true).ok, true)
    const out = readFileSync(file, 'utf8')
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('disabled:'))
    assert.ok(line, 'disabled 行消失了')
    assert.equal(indentOf(line), 6, `缩进被改写：应为 6，实得 ${indentOf(line)}`)
    assert.match(line.trim(), /^disabled: true$/)
    assert.deepEqual(structuralIssues(out), [], '写出的 patch 结构非法')
    // 对照：兄弟键一个都没被推走
    for (const k of ["name: 'ds-harness-remote'", 'inject: [ webServer ]']) {
      const l = out.split(/\r?\n/).find((x) => x.trim() === k)
      assert.equal(indentOf(l), 6, `兄弟键「${k}」缩进被改动`)
    }
  } finally {
    cleanup()
  }
})

test('顶层条目（dashIndent 2）：应写成缩进 4', () => {
  const src = ['row:', '  - id: plain-entry', '    name: plain-entity', ''].join('\n')
  const { file, cleanup } = fixture(src)
  try {
    assert.equal(patchSetDisabled(file, 'plain-entity', true).ok, true)
    const out = readFileSync(file, 'utf8')
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('disabled:'))
    assert.ok(line, '没有写出 disabled 行')
    assert.equal(indentOf(line), 4, `disabled 缩进应为 4（dashIndent 2 + 2），实得 ${indentOf(line)}`)
    assert.deepEqual(structuralIssues(out), [], '写出的 patch 结构非法')
  } finally {
    cleanup()
  }
})

test('反向对照：config 内部的同名 disabled 不是兄弟键，应另插一行而不是改它', () => {
  const src = [
    '- insert:',
    '    - id: nested-cfg',
    '      name: nested-cfg',
    '      config:',
    '        enabled: true',
    '        disabled: false',
    '',
  ].join('\n')
  const { file, cleanup } = fixture(src)
  try {
    assert.equal(patchSetDisabled(file, 'nested-cfg', true).ok, true)
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const nested = lines.find((l) => indentOf(l) === 8 && l.trim().startsWith('disabled:'))
    assert.ok(nested, 'config 内那行被删了？')
    assert.match(nested.trim(), /^disabled: false$/, 'config 内的 disabled 被改错了（那是插件的配置字段，不是开关）')
    const sibling = lines.find((l) => indentOf(l) === 6 && l.trim().startsWith('disabled:'))
    assert.ok(sibling, '没有在兄弟层插入 disabled')
    assert.match(sibling.trim(), /^disabled: true$/)
  } finally {
    cleanup()
  }
})

test('自检器有区分力：8 空格那一版必须被判非法（尸体样本）', () => {
  // 这就是修复前的输出形状——如果自检器认不出它，前面四条断言都是空转。
  const broken = ['- insert:', '    - id: ds-harness-remote', "      name: 'ds-harness-remote'", '        disabled: false', ''].join('\n')
  assert.notDeepEqual(structuralIssues(broken), [], '自检器认不出 8 空格的非法形状 ⇒ 判据没有区分力')
})
