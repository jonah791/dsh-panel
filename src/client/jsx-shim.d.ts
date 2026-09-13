/**
 * 客户端半边的**最小 JSX / React 类型垫片**（零依赖构建的代价与对策）。
 *
 * WHY 需要它（工程事实，非风格偏好）：
 *   本仓 `node_modules` 里**没有** `react` / `@types/react`（实测 2026-09-13），而
 *   live 插件目录跑 `pnpm install` 会触发 web 重启甚至崩溃循环（AGENTS.md §5.15 §7）——
 *   即「客户端源码的 JSX 类型」不能靠安装官方类型来获得。
 *   `jsx: react-jsx` 模式下 tsc 需要 `react/jsx-runtime` 的类型答案，否则直接报
 *   "Cannot find module 'react/jsx-runtime' or its corresponding type declarations"。
 *
 * 对策：本文件用**结构化最小投影**回答类型问题——只描述真正用到的两件事
 *   （「JSX 元素的形状」与「jsx/jsxs 工厂签名」），不复制官方 React 类型。
 * 代价（诚实声明）：内在元素属性在这里是 `unknown`，**props 拼写错误不会被 tsc 拦住**；
 *   按钮级组件可接受，复杂客户端组件应改用真实 `@types/react`（届时删掉本文件，
 *   二者不可共存——重复声明会报 duplicate identifier）。
 *
 * 与运行期的关系：**零关系**。本文件是 `.d.ts`，不产出任何字节；运行期仍由宿主模块表
 * 提供 `react/jsx-runtime`（平台种子模块），产物只 `require('react/jsx-runtime')`。
 */

declare module 'react' {
  /**
   * 只用到「返回一个元素」这一件事，故为结构化最小定义。
   * 与 `react/jsx-runtime` 的 `JSX.Element` 结构兼容（type/props 均为 unknown）。
   */
  export interface ReactElement {
    readonly type: unknown
    readonly props: unknown
  }
}

declare module 'react/jsx-runtime' {
  export namespace JSX {
    /** 元素形状——够测试与返回值标注使用。 */
    interface Element {
      readonly type: unknown
      readonly props: unknown
    }
    /** children 经 props.children 传入（jsx 运行时约定）。 */
    interface ElementChildrenAttribute {
      children: unknown
    }
    /** 内在元素属性一律 unknown：不拦拼写，只保证能编译。 */
    interface IntrinsicElements {
      [element: string]: unknown
    }
  }
  export function jsx(type: unknown, props: unknown, key?: unknown): JSX.Element
  export function jsxs(type: unknown, props: unknown, key?: unknown): JSX.Element
  export const Fragment: unknown
}
