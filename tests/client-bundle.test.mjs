/**
 * dsh-panel client 产物的行为测试（离线，无浏览器）。
 *
 * 这是对**构建产物**的测试，不是对源码的测试：DSH Web 客户端模块系统加载的是
 * `lib/client.js` 的字节，所以协议正确性只能在产物上验证——
 *   ① 产物必须自行调用 `window.__ModuleLoader__.load({ id, factory })`，且 id = 包名
 *   ② factory 的 exports 必须有 `apply`（缺失会让整个 Web UI boot 报
 *      "invalid plugin, expect function or object with an apply method" → 白屏）
 *   ③ 对模块表的请求必须只有平台种子模块（react/jsx-runtime）——多一个都会在
 *      浏览器里抛「模块表答不出来」
 *   ④ `apply` 必须在 `conversation.session.header.actions` 注册 id=`panel`、order=20
 *   ⑤ 组件点下去真的打开 `/panel/`
 *
 * 运行：node --test "tests/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const BUNDLE = new URL('../lib/client.js', import.meta.url)
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 在受控沙盒里执行产物，返回捕获到的注册信息与 spy。 */
function loadBundle() {
  const code = readFileSync(BUNDLE, 'utf8')
  let registration = null
  const opened = []
  const sandbox = {
    Symbol,
    console,
    window: {
      __ModuleLoader__: { load: (r) => { registration = r } },
      open: (...args) => { opened.push(args) },
    },
  }
  sandbox.globalThis = sandbox
  const context = createContext(sandbox)
  runInContext(code, context, { filename: 'client.js' })
  if (registration === null) throw new Error('产物没有调用 window.__ModuleLoader__.load')
  /** 模拟模块表：只答平台种子模块。 */
  const moduleTable = {
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    react: {},
  }
  const requested = []
  const requireFn = (id) => {
    requested.push(id)
    if (!(id in moduleTable)) throw new Error(`模块表答不出：${id}`)
    return moduleTable[id]
  }
  const exports = registration.factory(requireFn)
  return { registration, exports, requested, opened }
}

test('产物按模块协议注册，id = 包名', () => {
  const { registration } = loadBundle()
  assert.equal(registration.id, PKG.name, 'id 必须是包名——宿主按包名查表')
  assert.equal(typeof registration.factory, 'function')
})

test('exports 具备 apply / inject（缺 apply 会白屏）', () => {
  const { exports } = loadBundle()
  assert.equal(typeof exports.apply, 'function', 'apply 必须是函数，否则 client 模块 boot 报 invalid plugin')
  assert.deepEqual([...exports.inject], ['slots'])
})

test('只向模块表请求平台种子模块', () => {
  const { requested } = loadBundle()
  const allowed = new Set(['react', 'react/jsx-runtime'])
  const extra = requested.filter((id) => !allowed.has(id))
  assert.deepEqual(extra, [], `出现非平台种子模块请求：${extra.join(', ')}`)
  assert.ok(requested.length > 0, '至少要请求一次 jsx runtime')
})

test('apply 在 conversation.session.header.actions 注册唯一的「面板」入口', () => {
  const { exports } = loadBundle()
  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject: (name, cb) => { injected.push(name); cb() },
      register: (options, component) => { registered.push({ options, component }) },
    },
  }
  exports.apply(ctx)

  assert.deepEqual(injected, ['conversation.session.header.actions'])
  assert.equal(registered.length, 1, '只允许一个 GUI 入口')
  const entry = registered[0]
  assert.equal(entry.options.name, 'conversation.session.header.actions')
  assert.equal(entry.options.id, 'panel')
  assert.equal(entry.options.order, 20)
  assert.equal(typeof entry.component, 'function')
})

test('按钮渲染出「面板」文案，点击打开 /panel/', () => {
  const { exports, opened } = loadBundle()
  let registered = null
  const ctx = {
    slots: {
      inject: (_name, cb) => { cb() },
      register: (_options, component) => { registered = component },
    },
  }
  exports.apply(ctx)
  assert.ok(registered !== null)

  const node = registered()
  assert.equal(node.type, 'button')
  assert.equal(node.props.children, '面板')
  assert.equal(node.props.type, 'button')
  assert.equal(typeof node.props.onClick, 'function')

  node.props.onClick()
  assert.deepEqual(opened, [['/panel/', '_blank', 'noopener']], '点击必须打开面板宿主 /panel/')
})
