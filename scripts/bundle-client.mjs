#!/usr/bin/env node
/**
 * dsh-panel client bundle —— **零额外依赖**的客户端打包（只依赖本仓已装的 `typescript`）。
 *
 * WHY（协议而非风格）：
 *   DSH Web 客户端模块系统按 `package.json` 的 `./client` 导出**读取文件字节**，
 *   浏览器侧执行该文件，它必须自行调用 `window.__ModuleLoader__.load({ id, factory })`
 *   完成注册，且 `exports.apply` 必须存在（缺失 → 整个 Web UI boot 报
 *   "invalid plugin, expect function or object with an apply method" → 白屏）。
 *
 * 为什么不用 tsdown（2026-09-13 实测的依赖面）：
 *   本插件的 `node_modules` 里既没有 `tsdown` 也没有 `react` / `@types/react`，
 *   而 live 插件目录跑 `pnpm install` 会触发 web 重启甚至崩溃循环（AGENTS.md §5.15 §7）。
 *   于是旧的 `bundle` 脚本（`tsdown && wrap-client`）是**借别的仓的 tsdown** 才跑得起来。
 *   本脚本改用本仓**已经装着**的 tsc（`node_modules/typescript`，host 侧构建本来就要它）：
 *   编译 CJS → 自行拼装模块注册表 → 包装成协议要求的 `lib/client.js`。
 *
 * 流程：
 *   ① `tsc -p tsconfig.client.build.json`（CJS，输出 `lib/.client-build/**.js`，先清后编）
 *   ② 把每个产物注册为 `__modules["./相对路径.js"]`
 *   ③ 生成 `factory(require)`：相对请求走内部注册表，裸包名请求转交宿主模块表
 *      （宿主模块表只答平台种子模块——多要一个就在浏览器里抛「模块表答不出来」）
 *   ④ 自检：产物必须含 `__ModuleLoader__.load` 且 id = 包名；否则非零退出
 *
 * 用法：`npm run bundle`（或 `node scripts/bundle-client.mjs`）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = join(root, 'node_modules', 'typescript', 'lib', 'tsc.js')
const buildDir = join(root, 'lib', '.client-build')
const outFile = join(root, 'lib', 'client.js')
const staleCjs = join(root, 'lib', 'client.cjs')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ENTRY = './index.js'

/** 响亮失败：宁可不产出，也不产出「看起来成功了」的坏 bundle。 */
function die(message) {
  console.error(`[bundle] ${message}`)
  process.exit(1)
}

if (!existsSync(tsc)) {
  die(
    '缺少 typescript：找不到 ' + tsc + '\n' +
    '  处置：在本插件目录内安装（注意 live 插件目录装依赖会触发 web 重启，见 AGENTS.md §5.15 §7）：\n' +
    '    npm i -D typescript',
  )
}
if (!existsSync(join(root, 'tsconfig.client.build.json'))) {
  die('缺少 tsconfig.client.build.json（客户端 CJS 编译配置）')
}

// ① 先清后编：陈旧模块若残留，会被打进 bundle 且难以察觉
rmSync(buildDir, { recursive: true, force: true })
const compiled = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.client.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
if (compiled.error) die('调用 tsc 失败：' + compiled.error.message)
if (compiled.status !== 0) die(`tsc 退出码 ${compiled.status}（编译未通过，未产出 bundle）`)

// ② 收集产物（用 POSIX 相对 id，跨平台一致）
const emitted = []
;(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js')) emitted.push(full)
  }
})(buildDir)

if (!existsSync(join(buildDir, 'index.js'))) {
  die(`编译产物里没有 index.js（入口必须是 src/client/index.tsx）——实际产物：${emitted.map((f) => relative(buildDir, f)).join(', ') || '（空）'}`)
}

const registry = emitted
  .map((file) => {
    const id = './' + relative(buildDir, file).split(/[\\/]/).join('/')
    return `\t\t\t${JSON.stringify(id)}: function (module, exports, require) {\n${readFileSync(file, 'utf8')}\n\t\t\t},`
  })
  .join('\n')

// ③ 包装：相对请求走内部注册表（含 .js / /index.js 补全），裸包名转交宿主模块表
const wrapper = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar __modules = {
${registry}
\t\t};
\t\tvar __cache = {};
\t\tfunction __normalize(from, request) {
\t\t\tvar base = from.split('/');
\t\t\tbase.pop();
\t\t\tvar parts = request.split('/');
\t\t\tfor (var i = 0; i < parts.length; i++) {
\t\t\t\tvar part = parts[i];
\t\t\t\tif (part === '' || part === '.') continue;
\t\t\t\tif (part === '..') base.pop();
\t\t\t\telse base.push(part);
\t\t\t}
\t\t\treturn base.join('/');
\t\t}
\t\tfunction __load(id) {
\t\t\tif (__cache[id]) return __cache[id].exports;
\t\t\tvar module = { exports: {} };
\t\t\t__cache[id] = module;
\t\t\t__modules[id](module, module.exports, function (request) {
\t\t\t\tif (request.charAt(0) !== '.') return require(request);
\t\t\t\tvar resolved = __normalize(id, request);
\t\t\t\tvar candidates = [resolved, resolved + '.js', resolved + '/index.js'];
\t\t\t\tfor (var i = 0; i < candidates.length; i++) {
\t\t\t\t\tif (__modules[candidates[i]]) return __load(candidates[i]);
\t\t\t\t}
\t\t\t\tthrow new Error('[${pkg.name}] 模块未打进 bundle：' + request + '（来自 ' + id + '）');
\t\t\t});
\t\t\treturn module.exports;
\t\t}
\t\treturn __load(${JSON.stringify(ENTRY)});
\t}
});
`

// ④ 自检：产物必须自带注册调用；否则宁可失败
if (!wrapper.includes('window.__ModuleLoader__.load(') || !wrapper.includes(JSON.stringify(pkg.name))) {
  die('自检失败：生成的 bundle 未包含 __ModuleLoader__.load 或包名 id')
}
writeFileSync(outFile, wrapper, 'utf8')
rmSync(staleCjs, { force: true }) // 旧链路（tsdown → client.cjs）的残留物，避免误读为有效产物

console.log(
  `[bundle] client.js 已生成：${wrapper.length} 字符，模块 ${emitted.length} 个，id=${pkg.name}，入口=${ENTRY}`,
)
