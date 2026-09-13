/**
 * dsh-panel client bundle 配置（对齐 dsh-growth-profile 的已验证路径）。
 *
 * 产物形状：`lib/client.cjs`（CJS）→ `scripts/wrap-client.mjs` 包成
 * `window.__ModuleLoader__.load({ id, factory })` 的 `lib/client.js`——
 * 这是 DSH Web 客户端模块系统的加载协议（`./client` 导出必须指向该文件）。
 *
 * externals 全是**平台种子模块**（模块表已种下）：react / react-dom / cordis /
 * ui-slots / ui-primitives；`dsh-client-runtime/client` 由 shell 预载。
 * 其余依赖一律内联——跨插件运行期值导入会拿到重复的运行期实例。
 *
 * WHY 这里用**纯对象导出**而不是 `defineConfig({...})`：`defineConfig` 需要从
 * 'tsdown' 解析到本包的 node_modules，而 `devDependencies` 的安装不由本插件自主
 * （live 插件目录跑 pnpm install 会触发 web 重启/崩溃循环，见 AGENTS.md §5.15 §7）。
 * 纯对象对 tsdown 完全等价，且在依赖装上之前也能用同一份配置产出真实 bundle。
 */
export default {
  entry: { client: 'src/client/index.tsx' },
  format: ['cjs'],
  target: 'es2022',
  tsconfig: 'tsconfig.client.json',
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-runtime/client',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  outDir: 'lib',
  sourcemap: false,
  clean: false,
  dts: false,
}
