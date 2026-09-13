/**
 * 面板自带视觉（PanelStyle）：声明式、有形状校验、fail-loud。
 *
 * 理由：accent 是唯一进入 CSS 的贡献方字符串 —— 必须收敛为颜色字面量，
 * 且写错要当场暴露（静默丢弃 = 面板以为自己换了色，实际没有）。
 *
 * 运行：node --test "tests/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PanelRegistry, assertValidStyle, validateViewSpec } from '../lib/registry.js'

const NOW = '2026-09-13T09:30:00.000Z'

test('accent 形状：合法颜色字面量通过，其余拒绝', () => {
  for (const ok of ['#abc', '#a1b2c3', '#a1b2c3d4', '#ABC123']) {
    assert.doesNotThrow(() => { assertValidStyle('p', { accent: ok }) })
  }
  for (const bad of ['red', 'rgb(1,2,3)', '#12', 'var(--x)', 'javascript:alert(1)', '#12345', '; color:red']) {
    assert.throws(() => { assertValidStyle('p', { accent: bad }) }, /illegal style\.accent/, `${bad} 应被拒`)
  }
})

test('density：只认 comfortable / compact', () => {
  assert.doesNotThrow(() => { assertValidStyle('p', { density: 'compact' }) })
  assert.doesNotThrow(() => { assertValidStyle('p', { density: 'comfortable' }) })
  assert.throws(() => { assertValidStyle('p', { density: 'dense' }) }, /illegal style\.density/)
  assert.doesNotThrow(() => { assertValidStyle('p', undefined) })
})

test('注册即校验：坏 accent 会让注册 fail-loud（不静默丢弃）', () => {
  const registry = new PanelRegistry()
  assert.throws(() => {
    registry.register({
      id: 'bad', title: 'bad', style: { accent: 'red' }, view: () => ({ blocks: [] }),
    }, NOW)
  }, /illegal style\.accent/)
  // 注册失败后不得留下半截条目（否则后续同 id 注册会撞 duplicate）
  assert.equal(registry.get('bad'), undefined)
  assert.doesNotThrow(() => {
    registry.register({ id: 'bad', title: 'bad', style: { accent: '#0f0' }, view: () => ({ blocks: [] }) }, NOW)
  })
})

test('注册表投影携带 style，未声明则不出现该字段', () => {
  const registry = new PanelRegistry()
  registry.register({ id: 'with-style', title: 'A', style: { accent: '#f0b429', density: 'compact' }, view: () => ({ blocks: [] }) }, NOW)
  registry.register({ id: 'plain', title: 'B', view: () => ({ blocks: [] }) }, NOW)
  const list = registry.list()
  const withStyle = list.find((p) => p.id === 'with-style')
  const plain = list.find((p) => p.id === 'plain')
  assert.deepEqual(withStyle.style, { accent: '#f0b429', density: 'compact' })
  assert.equal('style' in plain, false, '未声明 style 的面板不应带空 style 字段')
})

test('宿主取数路径：坏规格 → 降级（不返回半截 spec）', () => {
  // 这里只断言校验函数本身与宿主使用同一入口（host.view 调 validateViewSpec）
  const bad = validateViewSpec({ blocks: [{ kind: 'chart', chart: 'bar' }] })
  assert.equal(bad.ok, false)
  assert.match(String(bad.error), /series/)
})
