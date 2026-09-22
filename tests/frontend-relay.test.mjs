/**
 * frontend-relay.test.mjs — 前端接入（中转站）防线的离线单测（纯逻辑层）
 *
 * 覆盖语义文档 §4.7 的两条 [MUST] 安全判据：
 *   A. `/panel-assets/<id>/…` 的路径穿越必须拒绝——**按插件根**校验，不得读到 assetsDir 之外的文件；
 *   B. `/api/panel/<id>/*` 只交给声明了 `handle` 的插件；未声明 → 404（**不回落、不猜测**）。
 *
 * 两条都带**对照组**（判据必须有区分力）：
 *   A 的对照 = 同一个 assetsRoot 下的合法文件必须能解析成功，且越界目标**真实存在**
 *   （若越界目标不存在，"拒绝"就只是"文件没有"，实验无结论）；
 *   B 的对照 = 声明了 handle 的条目必须放行，且放行后能真的调用它并拿回信封。
 *
 * 运行：node --test "tests/*.test.mjs"（跑的是 lib/ 产物 → 需先 npm run build）
 * 夹具纪律：全部落在 os.tmpdir()，不触碰任何生产资产。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { decodeRequestPath, planForward, resolvePanelAsset, resolvePluginRoot } from '../lib/frontend.js'

test('A 路径穿越：越出 assetsDir 的样本一律 404，且拒绝来自校验而非“文件不存在”', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-panel-assets-'))
  try {
    const pluginRoot = join(base, 'plugin')
    const assetsRoot = join(pluginRoot, 'web')
    mkdirSync(join(assetsRoot, 'sub'), { recursive: true })
    writeFileSync(join(assetsRoot, 'index.html'), '<!doctype html>ok', 'utf8')
    writeFileSync(join(assetsRoot, 'sub', 'app.js'), 'ok', 'utf8')
    // 越界目标：与 assetsDir **同级之外**的真实文件（装的是"资产外文件"）
    const outside = join(pluginRoot, 'outside-secret.txt')
    writeFileSync(outside, 'TOP-SECRET', 'utf8')

    // ---- 对照组 1：合法路径必须解析成功，且真的能读到 ----
    const good = resolvePanelAsset(assetsRoot, 'index.html')
    assert.equal(good.ok, true, '合法资产必须放行（否则本测试的拒绝断言没有区分力）')
    assert.equal(readFileSync(good.file, 'utf8'), '<!doctype html>ok')
    const nested = resolvePanelAsset(assetsRoot, 'sub/app.js')
    assert.equal(nested.ok, true)

    // ---- 对照组 2：越界目标真实存在（拒绝只能来自校验，不可能来自"文件不存在"）----
    assert.equal(existsSync(outside), true, '越界目标必须真实存在，否则实验无结论')

    // ---- 处理组：各类穿越样本一律拒绝，且给出 404 ----
    const escapes = [
      '../outside-secret.txt',
      'sub/../../outside-secret.txt',
      '..\\outside-secret.txt', // Windows 反斜杠（策略：URL 里出现反斜杠即视为穿越尝试）
      '/etc/passwd', // 绝对路径
      'C:\\Windows\\win.ini', // 盘符绝对路径
    ]
    for (const rel of escapes) {
      const r = resolvePanelAsset(assetsRoot, rel)
      assert.equal(r.ok, false, `穿越样本必须被拒：${rel}`)
      assert.equal(r.status, 404, `穿越样本必须给 404：${rel}`)
    }

    // ---- 链路：编码形态经 decodeRequestPath 解码后同样被拒（%2e%2e%2f 也拦得住）----
    for (const encoded of ['%2e%2e%2foutside-secret.txt', '%2e%2e/outside-secret.txt', 'sub%2f..%2f..%2foutside-secret.txt']) {
      const d = decodeRequestPath(`/panel-assets/demo/${encoded}`)
      assert.equal(d.ok, true, `合法编码应能解码：${encoded}`)
      const rel = d.path.slice('/panel-assets/demo/'.length)
      const r = resolvePanelAsset(assetsRoot, rel)
      assert.equal(r.ok, false, `编码穿越样本解码后必须被拒：${encoded}`)
    }

    // ---- 未声明 frontend 的插件 / 坏编码：同样是 404 级拒绝，不抛错 ----
    assert.equal(resolvePanelAsset(null, 'index.html').status, 404)
    assert.equal(decodeRequestPath('/panel-assets/demo/%zz').ok, false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('B 未声明 handle 的面板：/api/panel/<id>/* → 404（不回落不猜测）；声明了的必须放行', () => {
  // ---- 处理组 1：未注册的 id ----
  const unknown = planForward(undefined, 'ghost')
  assert.equal(unknown.kind, 'reject')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.reason, 'unknown-panel')

  // ---- 处理组 2：注册了、但没声明 handle（含"有 frontend 却无 handle"——不回落、不猜测）----
  for (const entry of [{}, { frontend: { assetsDir: 'web' } }, { frontend: { assetsDir: 'web', entry: 'index.html' }, view: () => ({ blocks: [] }) }]) {
    const r = planForward(entry, 'light')
    assert.equal(r.kind, 'reject', '未声明 handle 必须拒绝')
    assert.equal(r.status, 404, '未声明 handle 必须是 404（不是 500、不是回落）')
    assert.equal(r.reason, 'no-handle')
  }

  // ---- 对照组：声明了 handle 的条目必须放行，且放行后能真的调用（纯数据进 / 纯数据出）----
  const seen = []
  const entry = {
    handle: async (req) => {
      seen.push(req)
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ echo: req.path, q: req.query.x }) }
    },
  }
  const plan = planForward(entry, 'light')
  assert.equal(plan.kind, 'forward')
  return plan.handle({ method: 'GET', path: '/items', query: { x: '1' }, headers: {}, body: '' }).then((out) => {
    assert.equal(out.status, 200)
    assert.equal(JSON.parse(out.body).echo, '/items')
    assert.equal(JSON.parse(out.body).q, '1')
    assert.deepEqual(seen[0], { method: 'GET', path: '/items', query: { x: '1' }, headers: {}, body: '' }, '插件只应收到纯数据（无 Node 原生 req/res）')
  })
})

test('C 插件根解析：跳过框架帧、优先调用栈锚点，每级来源都如实标注', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-panel-root-'))
  try {
    // 假插件包：<tmp>/fake-plugin/{package.json, lib/index.mjs}（**真实** V8 栈从这里产生）
    const pluginDir = join(base, 'fake-plugin')
    mkdirSync(join(pluginDir, 'lib'), { recursive: true })
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'fake-plugin', type: 'module' }), 'utf8')
    writeFileSync(join(pluginDir, 'lib', 'index.mjs'), 'export function stackHere() { return new Error().stack }\n', 'utf8')
    const mod = await import(pathToFileURL(join(pluginDir, 'lib', 'index.mjs')).href)
    const expected = new Set([pluginDir, realpathSync.native(pluginDir)])
    // 组合树锚点故意指向别处：若实现偷懒用 baseUrl，root 会是 <base>/not-the-plugin
    const baseUrl = `${pathToFileURL(join(base, 'not-the-plugin')).href}/`

    // ---- 真实栈：贡献方模块 → 插件包根 ----
    const real = resolvePluginRoot({ stack: mod.stackHere(), baseUrl, cwd: tmpdir(), exists: existsSync })
    assert.equal(real.source, 'caller-module', '栈锚点必须优先于 baseUrl')
    assert.ok(expected.has(real.root), `解析出的插件根应为 ${pluginDir}，实得 ${real.root}`)

    // ---- 合成栈：宿主服务帧 + **框架代理帧**必须被跳过，取到贡献方 ----
    // （真实组成：register(host.js) ← cordis Proxy apply ← 贡献方；见 host.ts 的 CORDIS_PACKAGE_ROOT 注释）
    const hostFile = join(base, 'fake-host', 'lib', 'host.js')
    const cordisFrame = join(base, 'vendor', 'cordis', 'lib', 'types', 'utils.js')
    const stack = [
      'Error',
      `    at PanelHost.register (${pathToFileURL(hostFile).href}:60:25)`,
      `    at Object.apply (${pathToFileURL(cordisFrame).href}:211:30)`,
      `    at registerPanels (${pathToFileURL(join(pluginDir, 'lib', 'index.mjs')).href}:3:9)`,
    ].join('\n')
    const skipFramework = resolvePluginRoot({
      stack, cwd: tmpdir(), exists: existsSync,
      exclude: { roots: [join(base, 'vendor', 'cordis')], files: [hostFile], segments: ['cordis'] },
    })
    assert.equal(skipFramework.source, 'caller-module')
    assert.ok(expected.has(skipFramework.root), `框架帧必须被跳过（实得 ${skipFramework.root}）`)

    // ---- 宿主**内置面板**从宿主包内注册：根就是宿主包根（不得因"跳过宿主"而指错） ----
    const hostPkg = join(base, 'fake-host')
    mkdirSync(hostPkg, { recursive: true })
    writeFileSync(join(hostPkg, 'package.json'), JSON.stringify({ name: 'fake-host' }), 'utf8')
    const hostInternal = resolvePluginRoot({
      stack: [
        'Error',
        `    at PanelHost.register (${pathToFileURL(hostFile).href}:60:25)`,
        `    at ${pathToFileURL(join(hostPkg, 'lib', 'index.js')).href}:264:40`,
      ].join('\n'),
      cwd: tmpdir(), exists: existsSync,
      exclude: { files: [hostFile], segments: ['cordis'] },
    })
    assert.equal(hostInternal.root, hostPkg, '宿主内置面板的插件根 = 宿主包根（其 assetsDir 相对它解析）')

    // ---- 兜底链：无栈 → baseUrl；两者皆无 → cwd（来源如实标注，不假装是推导出来的） ----
    const baseUrlFinding = resolvePluginRoot({ baseUrl, cwd: tmpdir(), exists: existsSync })
    assert.equal(baseUrlFinding.source, 'config-tree')
    assert.equal(baseUrlFinding.root, resolve(join(base, 'not-the-plugin')))
    const fallback = resolvePluginRoot({ cwd: pluginDir, exists: existsSync })
    assert.equal(fallback.source, 'cwd')
    assert.equal(fallback.root, resolve(pluginDir))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
