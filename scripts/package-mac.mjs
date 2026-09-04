/**
 * macOS 便携版打包：结构与 package-win.mjs 同构。
 *
 * 只能在 macOS 上运行（打包机 = 目标系统）：Node 二进制直接取打包机的
 * process.execPath；启动器为双击可运行的 .command 脚本（bash，macOS 自带依赖）。
 * 末尾同款冒烟验证：用打出来的产物起服务探活 /api/capabilities。
 *
 * 运行：pnpm package:mac
 * 产物：release/清华小助手-macOS/（压缩整个文件夹分发）
 */
import {chmod, cp, mkdir, rm, writeFile} from "node:fs/promises";
import {execFileSync, spawn} from "node:child_process";
import net from "node:net";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "release", "清华小助手-macOS");
const app = join(release, "app");
const runtime = join(release, "runtime");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (process.platform !== "darwin") {
    console.error("package:mac 只能在 macOS 上运行（Node 二进制与启动器都随打包机平台）。Windows 用户请用 pnpm package:win:exe。");
    process.exit(1);
}

await rm(release, {recursive: true, force: true});
await mkdir(runtime, {recursive: true});

execFileSync(pnpmCommand, ["run", "build"], {cwd: root, stdio: "inherit"});
execFileSync(pnpmCommand, ["--filter", ".", "deploy", "--prod", "--legacy", app], {cwd: root, stdio: "inherit"});
await cp(join(root, "dist"), join(app, "dist"), {recursive: true});
// macOS 包与 Windows 网页包一样，只提供聊天界面，不携带 MCP 连接入口。
await rm(join(app, "dist", "scripts", "mcp-server.cjs"), {force: true});
await rm(join(app, "dist", "scripts", "mcp-login.cjs"), {force: true});
await cp(join(root, "openssl.cnf"), join(release, "openssl.cnf"));
await cp(join(root, ".env.example"), join(release, ".env.example"));
await cp(process.execPath, join(runtime, "node"));
await chmod(join(runtime, "node"), 0o755);

// 启动器：macOS 双击 .command 即在终端运行；关闭终端窗口或 Ctrl+C 即退出
const launcher = join(release, "清华小助手.command");
await writeFile(launcher, `#!/bin/bash
# 清华小助手（macOS 便携版）启动器
cd "$(dirname "$0")"
export OPENSSL_CONF="$(pwd)/openssl.cnf"
if [ ! -f .env ]; then
  echo "请先复制 .env.example 为 .env，并至少填写 LLM_API_KEY。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# 找可用端口（3457 起向后试 20 个）
PORT=3457
for p in $(seq 3457 3476); do
  if ! nc -z 127.0.0.1 "$p" 2>/dev/null; then PORT=$p; break; fi
done

./runtime/node app/dist/scripts/step18-web.cjs &
NODE_PID=$!
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/capabilities" > /dev/null 2>&1; then
    open "http://127.0.0.1:$PORT"
    break
  fi
  sleep 0.25
done
wait $NODE_PID
`, {mode: 0o755});

await writeFile(join(release, "README.txt"), `清华小助手（macOS 便携版）

1. 将本文件夹中的 .env.example 复制为 .env。
   （以点开头的文件在访达中默认隐藏，按 Cmd+Shift+. 即可显示。）
2. 打开 .env，至少填写 LLM_API_KEY；按需填写 LLM_BASE_URL、LLM_MODEL。
3. 双击"清华小助手.command"（首次若被 Gatekeeper 拦截：右键该文件 → 打开 → 确认；
   或在"系统设置 → 隐私与安全性"里允许）。程序会自动启动服务并打开浏览器。
4. 在网页右上角点击"登录"，输入清华 Info 学号、密码和二次验证码。
5. 退出：关闭终端窗口，或在终端里按 Ctrl+C。

清华账号和验证码不会写入文件。
程序默认只监听本机回环地址；如需局域网（手机）访问，在 .env 里配置
UI_TOKEN=自定义口令，并在防火墙放行对应端口。
`);

// ===== 冒烟验证：用打包产物自己起一次服务，探活 /api/capabilities =====
const findFreePort = (start, count) => new Promise((resolvePort, rejectPort) => {
    let port = start;
    const tryNext = () => {
        if (port >= start + count) return rejectPort(new Error("找不到可用端口"));
        const listener = net.createServer();
        listener.once("error", () => {
            listener.close();
            port += 1;
            tryNext();
        });
        listener.listen(port, "127.0.0.1", () => listener.close(() => resolvePort(port)));
    };
    tryNext();
});

console.log("冒烟验证：用打包产物启动一次本地服务……");
const smokePort = await findFreePort(39457, 20);
const smoke = spawn(join(runtime, "node"), [join(app, "dist", "scripts", "step18-web.cjs")], {
    cwd: release,
    env: {...process.env, PORT: String(smokePort), HOST: "127.0.0.1", OPENSSL_CONF: join(release, "openssl.cnf")},
    stdio: ["ignore", "pipe", "pipe"],
});
let smokeOutput = "";
smoke.stdout.on("data", (chunk) => { smokeOutput += chunk; });
smoke.stderr.on("data", (chunk) => { smokeOutput += chunk; });
let smokeOk = false;
for (let i = 0; i < 60; i += 1) {
    if (smoke.exitCode !== null) break;
    try {
        const resp = await fetch(`http://127.0.0.1:${smokePort}/api/capabilities`);
        if (resp.ok) { smokeOk = true; break; }
    } catch { /* 还没起好，继续等 */ }
    await new Promise((r) => setTimeout(r, 250));
}
smoke.kill();
if (!smokeOk) {
    console.error(`冒烟验证失败：打包产物未能启动本地服务（端口 ${smokePort}）。\n进程输出：\n${smokeOutput.slice(0, 2000)}`);
    process.exit(1);
}
console.log(`冒烟验证通过：/api/capabilities 响应正常（探活端口 ${smokePort}）。`);
console.log(`macOS 发布包已生成：${release}`);
