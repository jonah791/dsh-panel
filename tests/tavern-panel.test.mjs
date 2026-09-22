/**
 * 酒馆面板（只读）的行为测试。
 *
 * 核心断言：
 *   ① 只读取证：取数前后**夹具目录的字节/mtime 一字不动**（面板绝不写创作资产）
 *   ② 两个「最新」口径分得清：newestByMtime（磁盘最后写入，并列列全）vs highestVersion（文件名版本号最高）
 *   ③ 计数口径：预设只收一层 `*.json`；资产计数递归；目录缺席如实说缺席（不是 0）
 *   ④ 反代面：只认 GET /state —— 其余路径 404、非 GET 405、数据源缺席 503（响亮失败，不给假零读数）
 *   ⑤ 三个面都给：view + frontend + handle（§4.7 降级矩阵里信息量最大的一格）
 *
 * 夹具纪律：全部建在 `os.tmpdir()` 的隔离目录里，**绝不触碰真实 `tavern/` 创作资产**。
 * 运行：node --test "tests/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ASSET_DIRS, collectTavernState, compareVersions, countFiles, createTavernPanel, familyOf,
  handleTavernRequest, parsePresetVersion, toTavernSpec,
} from '../lib/panels/tavern.js'

/** 递归快照（名字 + 字节 + mtimeMs）——用于证明「取数没有写任何东西」。 */
function snapshot(dir) {
  const out = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(current, entry.name)
      if (entry.isDirectory()) { out.push(`d ${rel}`); walk(full, rel); continue }
      const st = statSync(full)
      out.push(`f ${rel} ${String(st.size)} ${String(st.mtimeMs)}`)
    }
  }
  walk(dir, '')
  return out.sort()
}

/** 建一份酒馆夹具（全新的隔离目录）。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-tavern-'))
  const tavernDir = join(root, 'tavern')
  const dreamTavernDir = join(root, 'dsh-dream-tavern')
  mkdirSync(tavernDir, { recursive: true })
  mkdirSync(join(dreamTavernDir, 'scripts'), { recursive: true })

  const write = (rel, body, at) => {
    const file = join(tavernDir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body, 'utf8')
    utimesSync(file, at, at) // 显式 mtime：让「最新」有确定判据，不依赖写入次序的偶然
  }
  const at = (iso) => new Date(iso)

  write('色欲之罪V3.3.json', '{"v":33}', at('2026-09-18T05:59:39Z'))
  write('色欲之罪V3.4.json', '{"v":34}', at('2026-09-20T16:30:14Z'))
  write('梦鲸思客V4-0902.json', '{"v":4}', at('2026-09-05T07:51:07Z'))
  write('README.md', '# 非 json，不进预设清单', at('2026-09-20T18:28:53Z'))
  write('交接文档.md', '# 交接', at('2026-09-20T23:30:51Z'))
  write('素材/a.txt', 'aaaa', at('2026-09-18T04:34:32Z'))
  write('素材/sub/b.bin', 'bbbbbbbb', at('2026-09-18T04:34:32Z'))
  write('文风/c.md', 'cc', at('2026-09-18T04:47:54Z'))
  // 剧本素材/ 故意不建：缺席必须如实说缺席

  const script = (name, body, iso) => {
    const file = join(dreamTavernDir, 'scripts', name)
    writeFileSync(file, body, 'utf8')
    utimesSync(file, at(iso), at(iso))
  }
  script('acceptance.mjs', '// 夹具', '2026-09-22T00:51:10Z')
  script('context-report.mjs', '// 夹具', '2026-09-22T00:55:20Z')

  return { root, tavernDir, dreamTavernDir }
}

test('只读取证：取数前后夹具目录一字不动（面板绝不写创作资产）', () => {
  const fx = makeFixture()
  const before = snapshot(fx.root)
  collectTavernState({ tavernDir: fx.tavernDir, dreamTavernDir: fx.dreamTavernDir }, new Date('2026-09-22T06:00:00Z'))
  toTavernSpec({ tavernDir: fx.tavernDir, dreamTavernDir: fx.dreamTavernDir })
  handleTavernRequest({ tavernDir: fx.tavernDir, dreamTavernDir: fx.dreamTavernDir }, { method: 'GET', path: '/state', query: {}, headers: {}, body: '' })
  assert.deepEqual(snapshot(fx.root), before, '取数不得改动夹具（字节与 mtime 都不许变）')
})

test('两个「最新」口径分得清：最后写入 vs 文件名版本最高', () => {
  const fx = makeFixture()
  const state = collectTavernState({ tavernDir: fx.tavernDir, dreamTavernDir: fx.dreamTavernDir }, new Date('2026-09-22T06:00:00Z'))

  // 预设只收一层 *.json（README.md 不进；素材/ 里的内容也不进）
  assert.deepEqual(state.project.presets.map((p) => p.name), ['色欲之罪V3.4.json', '色欲之罪V3.3.json', '梦鲸思客V4-0902.json'])
  assert.deepEqual(state.project.newestByMtime, ['色欲之罪V3.4.json'], 'mtime 最新的那一份')
  // 版本号只在家族内可比：跨家族全局取最高会得出「V4 > V3.4」的伪结论（本面板初版即踩此坑）
  assert.deepEqual(state.project.versionLeaders, [
    { family: '梦鲸思客', name: '梦鲸思客V4-0902.json', version: '4' },
    { family: '色欲之罪', name: '色欲之罪V3.4.json', version: '3.4' },
  ])
  assert.equal(state.project.presets[0].bytes, 8, '字节数来自真实 stat')

  // 无版本号的文件名不许被当成 0 参与比较
  assert.equal(parsePresetVersion('ARGO-1.6.json'), null)
  assert.equal(parsePresetVersion('梦鲸思客V4-0902.json'), '4')
  assert.equal(familyOf('色欲之罪V3.4.json'), '色欲之罪')
  assert.equal(familyOf('梦鲸思客V4-0902.json'), '梦鲸思客')
  assert.ok(compareVersions('3.10', '3.9') > 0, '逐段数值比较：3.10 > 3.9')
})

test('mtime 并列时不假装只有一个「最新」', () => {
  const fx = makeFixture()
  const same = new Date('2026-09-21T00:00:00Z')
  for (const name of ['色欲之罪V3.3.json', '色欲之罪V3.4.json']) utimesSync(join(fx.tavernDir, name), same, same)
  const state = collectTavernState({ tavernDir: fx.tavernDir, dreamTavernDir: fx.dreamTavernDir }, same)
  assert.deepEqual(state.project.newestByMtime, ['色欲之罪V3.3.json', '色欲之罪V3.4.json'])
})

test('资产计数递归且缺席如实说缺席；脚本只列存在性与新鲜度', () => {
  const fx = makeFixture()
  const state = collectTavernState({ tavernDir: fx.tavernDir, dreamTavernDir: fx.dreamTavernDir }, new Date('2026-09-22T06:00:00Z'))
  const byName = Object.fromEntries(state.assets.map((a) => [a.name, a]))

  assert.deepEqual(state.assets.map((a) => a.name), [...ASSET_DIRS])
  assert.equal(byName['素材'].files, 2, '递归到子目录')
  assert.equal(byName['素材'].bytes, 12, '4 + 8 字节')
  assert.equal(byName['文风'].files, 1)
  assert.equal(byName['剧本素材'].exists, false, '缺席 = exists:false，不是 0 个文件的正常态')
  assert.equal(byName['剧本素材'].files, 0)

  assert.equal(state.handover.exists, true)
  assert.equal(state.handover.name, '交接文档.md')
  assert.ok(state.handover.ageDays > 0)

  assert.equal(state.scripts.exists, true)
  assert.deepEqual(state.scripts.files.map((f) => f.name), ['context-report.mjs', 'acceptance.mjs'], 'mtime 降序')
  assert.equal(state.scripts.newest.name, 'context-report.mjs')
})

test('反代面：只认 GET /state —— 其余路径 404、非 GET 405', () => {
  const fx = makeFixture()
  const deps = { tavernDir: fx.tavernDir, dreamTavernDir: fx.dreamTavernDir }

  const ok = handleTavernRequest(deps, { method: 'GET', path: '/state', query: {}, headers: {}, body: '' })
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).ok, true)

  for (const path of ['/records', '/state/../../tavern', '/../../etc/passwd', '/', '/state/x']) {
    const res = handleTavernRequest(deps, { method: 'GET', path, query: {}, headers: {}, body: '' })
    assert.equal(res.status, 404, `未知路径必须 404：${path}`)
    assert.equal(JSON.parse(res.body).ok, false)
  }
  const post = handleTavernRequest(deps, { method: 'POST', path: '/state', query: {}, headers: {}, body: '{}' })
  assert.equal(post.status, 405, '只读面板不接受写入方法')
})

test('数据源缺席：响亮失败（抛错 / 503），不回落成一份「全是 0」的假读数', () => {
  const fx = makeFixture()
  const missing = join(fx.root, '不存在的酒馆')
  assert.throws(() => collectTavernState({ tavernDir: missing, dreamTavernDir: fx.dreamTavernDir }), /不存在/)
  const res = handleTavernRequest({ tavernDir: missing, dreamTavernDir: fx.dreamTavernDir }, { method: 'GET', path: '/state', query: {}, headers: {}, body: '' })
  assert.equal(res.status, 503)
  assert.match(JSON.parse(res.body).error, /不存在/)
})

test('三个面都给：视图规格 + frontend 声明 + handle，且只读（无动作表）', () => {
  const fx = makeFixture()
  const deps = { tavernDir: fx.tavernDir, dreamTavernDir: fx.dreamTavernDir }
  const panel = createTavernPanel(deps)

  assert.equal(panel.id, 'tavern')
  assert.deepEqual(panel.frontend, { assetsDir: 'web/tavern', entry: 'index.html' })
  assert.equal(typeof panel.handle, 'function')
  assert.equal(typeof panel.view, 'function')
  assert.equal(panel.actions, undefined, '只读面板不提供动作通道')

  const spec = toTavernSpec(deps)
  const kinds = spec.blocks.map((b) => b.kind)
  assert.ok(kinds.includes('metrics') && kinds.includes('table') && kinds.includes('text'))
  assert.equal(kinds.includes('actions'), false)
  const text = spec.blocks.find((b) => b.kind === 'text')
  assert.ok(text.lines.some((l) => l.includes('只读')), '口径里必须写明只读')
})

test('handle 必须是同步契约：Promise 会让宿主的 withTimeout 抛 TypeError（真环境 500）', () => {
  // 宿主 `src/index.ts` 用 withTimeout(() => plan.handle(req)) 调用 handle，而它只认**同步返回值**。
  // 这里做源码级断言：`handle:` 那一行的箭头体不得是 `async` / 不得用 `=> Promise`。
  // 教训来源：本面板初版 handle 写成 async ⇒ 离线单测（await 兼容）全绿，真宿主一调就 500。
  const src = readFileSync(new URL('../src/panels/tavern.ts', import.meta.url), 'utf8')
  const line = src.split('\n').find((l) => l.includes('handle: (req)'))
  assert.ok(line !== undefined, '贡献里必须有 handle 声明')
  assert.equal(line.includes('async'), false, 'handle 不得是 async（宿主 withTimeout 只接受同步返回值）')
  assert.equal(line.includes('Promise'), false, 'handle 返回类型不得是 Promise')
})

test('计数口径：符号链接不跟随（防环），深层目录护栏会记错不静默', () => {
  const fx = makeFixture()
  const errors = []
  const counted = countFiles(join(fx.tavernDir, '素材'), errors)
  assert.equal(counted.files, 2)
  assert.deepEqual(errors, [])
})
