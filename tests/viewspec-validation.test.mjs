/**
 * ViewSpec 形状校验（v0.5）：让面板**响亮降级**，而不是静默渲染成空块。
 *
 * 立场：未知 kind 一律放行（渲染器降级成"未知块"提示，白名单先小后扩），
 * 但已知 kind 的必备数组字段缺失 = "看起来成功"的失败 → 必须拦。
 *
 * 运行：node --test "tests/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateViewSpec, VIEW_MAX_BLOCKS, VIEW_MAX_DEPTH } from '../lib/registry.js'

test('合法规格：各块类型通过（含新块族与未知块）', () => {
  const spec = {
    blocks: [
      { kind: 'metrics', items: [{ label: 'a', value: '1' }] },
      { kind: 'table', columns: [{ key: 'k', label: 'K' }], rows: [] },
      { kind: 'form', actionId: 'post', fields: [{ name: 'title', label: '标题' }] },
      { kind: 'chart', chart: 'donut', series: [{ label: 'ok', value: 3 }] },
      { kind: 'log', lines: [{ at: '12:00:00', level: 'error', text: 'x' }] },
      { kind: 'progress', items: [{ label: 'p', value: 1, max: 2 }] },
      { kind: 'tabs', items: [{ label: '一', blocks: [{ kind: 'text', lines: ['a'] }] }] },
      { kind: 'sections', blocks: [{ kind: 'kv', pairs: [{ key: 'k', value: 'v' }] }] },
      { kind: 'future-block-kind', whatever: 1 },
    ],
  }
  assert.deepEqual(validateViewSpec(spec), { ok: true })
})

test('顶层形状：非对象 / blocks 非数组一律拒绝', () => {
  assert.equal(validateViewSpec(null).ok, false)
  assert.equal(validateViewSpec([]).ok, false)
  assert.equal(validateViewSpec('x').ok, false)
  const r = validateViewSpec({})
  assert.equal(r.ok, false)
  assert.match(r.error, /blocks/)
})

test('块形状：非对象 / 缺 kind / kind 非字符串一律拒绝', () => {
  assert.equal(validateViewSpec({ blocks: [null] }).ok, false)
  assert.equal(validateViewSpec({ blocks: [42] }).ok, false)
  const noKind = validateViewSpec({ blocks: [{ title: 'x' }] })
  assert.equal(noKind.ok, false)
  assert.match(noKind.error, /kind/)
})

test('已知 kind 缺必备数组字段 → 拒绝并指出字段名', () => {
  const cases = [
    [{ kind: 'metrics' }, /items/],
    [{ kind: 'form', actionId: 'post' }, /fields/],
    [{ kind: 'chart', chart: 'bar' }, /series/],
    [{ kind: 'log' }, /lines/],
    [{ kind: 'progress' }, /items/],
    [{ kind: 'tabs', items: [{ label: '一' }] }, /blocks/],
  ]
  for (const [block, re] of cases) {
    const r = validateViewSpec({ blocks: [block] })
    assert.equal(r.ok, false, `${JSON.stringify(block)} 应当被拒`)
    assert.match(r.error, re)
  }
})

test('chart 只认 bar/line/donut；form 必须带 actionId', () => {
  assert.equal(validateViewSpec({ blocks: [{ kind: 'chart', chart: 'pie', series: [] }] }).ok, false)
  const noAction = validateViewSpec({ blocks: [{ kind: 'form', fields: [] }] })
  assert.equal(noAction.ok, false)
  assert.match(noAction.error, /actionId/)
})

test('预算：嵌套超过上限 → 拒绝；块数量超过上限 → 拒绝', () => {
  /** 造 depth 层嵌套的 sections。 */
  function nest(depth) {
    let node = { kind: 'text', lines: ['leaf'] }
    for (let i = 0; i < depth; i++) node = { kind: 'sections', blocks: [node] }
    return node
  }
  assert.equal(validateViewSpec({ blocks: [nest(VIEW_MAX_DEPTH - 1)] }).ok, true, '上限内应通过')
  const tooDeep = validateViewSpec({ blocks: [nest(VIEW_MAX_DEPTH + 1)] })
  assert.equal(tooDeep.ok, false)
  assert.match(tooDeep.error, /嵌套/)

  const many = { blocks: Array.from({ length: VIEW_MAX_BLOCKS + 1 }, () => ({ kind: 'text', lines: [] })) }
  const tooMany = validateViewSpec(many)
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.error, /块数量/)
})
