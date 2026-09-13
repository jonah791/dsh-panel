/**
 * dsh-panel 的 client 半边：官方 Web GUI 里**唯一**的自研入口。
 *
 * 主人 2026-09-13 定调：GUI 只留 1 个入口——会话头的「面板」按钮，点开面板宿主 `/panel/`；
 * 其余自研前端（插件管理 / 任务板 / 养成档案 / 分身）全部改成面板宿主里的一页
 * （见 docs/semantic.md §6：独立页 `/panel/` 是主通道，官方 client slot 不是）。
 *
 * 形态纪律：
 *   - 只注册 **一个** `conversation.session.header.actions` 贡献，不做任何 RPC——按钮只做一次
 *     `window.open`，因此不需要 `remote`/`$mount`（那是需要 host 调用的插件才付的成本）。
 *   - 用**结构化最小投影**描述用到的运行时面，不运行期 import 官方 client 包：
 *     跨包运行期命名导入会因解析路径不同而炸（dsh-growth-profile/src/panel.ts 同款纪律）。
 *     本插件对模块表的全部要求只有平台种子里的 `react`。
 * @module dsh-panel/client
 */

import type { ReactElement } from 'react'

/** 槽位服务的最小投影（只用到 inject + register 两项）。 */
interface SlotsLike {
  inject: (name: string, callback: () => void) => void
  register: (options: { name: string; id: string; order?: number }, component: () => unknown) => void
}

/** Client 上下文的最小投影。 */
interface ClientContextLike {
  slots: SlotsLike
}

/** 只依赖槽位服务（`ui-slots` 是平台种子模块）。 */
export const inject = ['slots'] as const

/** 面板宿主独立页地址（语义文档 §4.4 的权威路径）。 */
const PANEL_URL = '/panel/'

/** 会话头动作组件：打开面板宿主。 */
function PanelAction(): ReactElement {
  return (
    <button
      type="button"
      title="打开面板宿主（插件管理 / 任务板 / 养成档案 / 分身）"
      onClick={() => { window.open(PANEL_URL, '_blank', 'noopener') }}
      style={{
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))',
        borderRadius: 6,
        padding: '2px 10px',
        fontSize: 11,
        lineHeight: '18px',
        cursor: 'pointer',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #cfd3d6)',
      }}
    >
      面板
    </button>
  )
}

/**
 * 注册唯一的 GUI 入口。
 * @param ctx - client 上下文（仅用 slots）
 */
export function apply(ctx: ClientContextLike): void {
  // 用 slots.inject 等待槽位**声明**就绪（声明由官方 ui-conversation 提供）——
  // 裸 register 到未声明槽位会 fail-loud。
  ctx.slots.inject('conversation.session.header.actions', () => {
    ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'panel',
      order: 20,
    }, PanelAction)
  })
}
