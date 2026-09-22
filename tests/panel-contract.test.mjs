/**
 * panel-contract.test.mjs — 两条「契约级」断言（都源于真实事故，不是假想）
 *
 * 1. **版本一致性**：`src/index.ts` 的 `VERSION` 常量与 `package.json` 的 `version` 必须相等。
 *    事故：二者漂移过（常量 0.4.0 / 包 0.4.1），因为**没有任何判据会亮**，它在集成时把我
 *    的验收脚本带进了假红——我拿 `host.version` 当「新代码已加载」判据，于是把**已经成功的
 *    重启**误报为失败。约束必须配一条会亮的判据，否则它只是文字（语义文档 §7.3 同款教训）。
 *
 * 2. **三者皆无 ⇒ 注册 fail-loud**（语义文档 §4.7 降级矩阵最后一行）：
 *    `view`/`frontend`/`handle` 一个都不给的面板，在界面上是一张点进去什么都没有的卡片——
 *    又一种「看起来成功」的失败。带**对照组**：只给其中任一个都必须放行（否则这条断言
 *    也可以被"什么都拒绝"的坏实现满足，等于没有区分力）。
 *
 * 运行：node --test "tests/*.test.mjs"（跑 lib/ 产物 ⇒ 需先 npm run build）
 * 夹具纪律：不落盘、不碰生产资产（纯内存断言 + 只读源文件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PanelRegistry } from '../lib/registry.js'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

test('版本一致性：index.ts 的 VERSION 常量 === package.json 的 version', () => {
  const src = readFileSync(join(pkgRoot, 'src', 'index.ts'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

  const match = /export const VERSION = '([^']+)'/.exec(src)
  assert.ok(match, 'index.ts 里应存在 `export const VERSION = \'…\'`（若改写法请同步本测试）')
  const constant = match[1]

  assert.equal(
    constant,
    pkg.version,
    `VERSION 常量（${constant}）与 package.json（${pkg.version}）漂移——`
    + '两者必须一致：否则 host.version 这个对外读数不可信（曾经导致"已完成的重启"被误报为失败）',
  )
})

test('降级矩阵：view/frontend/handle 三者皆无 → 注册 fail-loud；任给其一 → 放行', () => {
  const base = { id: 'demo', title: '演示' }
  const fresh = () => new PanelRegistry()

  // ---- 处理组：三者皆无 ⇒ 必须抛错 ----
  assert.throws(
    () => fresh().register({ ...base }, new Date().toISOString()),
    /必须至少声明 view \/ frontend \/ handle 之一/,
    '三者皆无的贡献必须被注册期拒绝',
  )

  // ---- 对照组：任给其一都必须放行（否则"全拒绝"的坏实现也能满足上面的断言）----
  const cases = [
    ['仅 view', { view: () => ({ blocks: [] }) }],
    ['仅 frontend', { frontend: { assetsDir: 'web', entry: 'index.html' } }],
    ['仅 handle', { handle: () => ({ status: 200, body: 'ok' }) }],
  ]
  for (const [label, extra] of cases) {
    const dispose = fresh().register({ ...base, ...extra }, new Date().toISOString())
    assert.equal(typeof dispose, 'function', `${label}：应注册成功并返回 disposer`)
  }

  // ---- 边界：显式 undefined 与"缺省"等价（不能靠属性存在与否绕过）----
  assert.throws(
    () => fresh().register({ ...base, view: undefined, frontend: undefined, handle: undefined }, new Date().toISOString()),
    /必须至少声明/,
    '显式 undefined 不应绕过校验',
  )
})
