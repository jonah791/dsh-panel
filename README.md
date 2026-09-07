# dsh-panel

> 独立实时前端面板：宿主托管自包含 HTML + HTTP API，零官方 client 依赖。
> DeepSeek Harness 自研插件 · v0.1.0

## 定位

给 DSH 提供不依赖官方 web client 的**独立前端面板**——宿主（webServer）托管自包含 HTML，通过 HTTP API 与宿主通信。首版 = 插件管理（替代官方失效的「插件」tab）。

## 功能特性

- **自包含 HTML**：面板是一个独立的 HTML 文件，宿主 webServer 直接托管
- **HTTP API**：面板通过同源 fetch 与宿主通信（插件档案/生命周期操作）
- **零官方 client 依赖**：不依赖官方 client bundle，官方前端坏了面板照常可用
- **首版功能**：插件管理（清单/用途/状态），替代官方失效的插件 tab

## 安装

```bash
git clone https://github.com/jonah791/dsh-panel.git self-plugins/dsh-panel
cd self-plugins/dsh-panel && pnpm install && pnpm build
```

挂载到 web profile。

## 使用

- 浏览器访问面板 URL（宿主 webServer 托管路径）
- 面板内完成插件查看/管理，无需官方 client

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `path` | 配置值 | 面板访问路径 |

## 技术要点

- 同源 fetch：面板与宿主同源，无跨域问题
- 自包含：替换/升级面板只换一个 HTML 文件
- 遵循 dsh-panel-plugin 技能方法论（webServer 托管 + 独立资源 + 同源 fetch + 命名规范）

## License

MIT