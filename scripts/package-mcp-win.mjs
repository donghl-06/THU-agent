import {cp, mkdir, readdir, rm, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "release", "清灵-MCP");
const runtime = join(release, "runtime");
const mcpEntry = join(root, "dist", "scripts", "mcp-server.cjs");
const loginEntry = join(root, "dist", "scripts", "mcp-login.cjs");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

execFileSync(pnpmCommand, ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    ...(process.platform === "win32" ? {shell: true} : {}),
});

// 先构建再清理：构建失败时不能把可用的发布包先删掉。
// Codex 可能正从这个目录运行 runtime/node.exe。Windows 会锁定正在运行的 exe，
// 因此这里不能删除整个 release 目录；同时保留用户本机的 .env，避免重新打包丢凭证。
await mkdir(release, {recursive: true});
for (const entry of await readdir(release, {withFileTypes: true})) {
    if (entry.name === "runtime" || entry.name === ".env") continue;
    await rm(join(release, entry.name), {recursive: true, force: true});
}
await mkdir(runtime, {recursive: true});

await cp(mcpEntry, join(release, "mcp-server.cjs"));
await cp(loginEntry, join(release, "login.cjs"));
await cp(join(root, "openssl.cnf"), join(release, "openssl.cnf"));
await cp(join(root, "packaging", "mcp.env.example"), join(release, ".env.example"));
const nodeExecutable = join(runtime, "node.exe");
if (existsSync(nodeExecutable)) {
    console.warn(`MCP runtime 正在使用或已存在，保留现有文件：${nodeExecutable}`);
} else {
    await cp(process.execPath, nodeExecutable);
}
await writeFile(join(release, "登录清华账号.cmd"), `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0login.cjs"\r\necho.\r\npause\r\n`);

await writeFile(join(release, "README.txt"), `清灵 MCP 连接包（Windows 便携版）

本安装包用于让已经安装的 Codex、Claude Desktop 等 MCP Agent 调用清华校园查询能力。
它不包含“清灵.exe”网页聊天界面，也不需要安装 Node.js、pnpm 或 Git。

1. 将本文件夹中的 .env.example 复制为 .env。
2. 打开 .env，填写 THU_USERNAME、THU_PASSWORD；THU_FINGERPRINT 可留空，清灵会自动保存在本机。
3. 在 Codex 的 MCP 配置中添加：

[mcp_servers.thu_assistant]
command = "本目录\\runtime\\node.exe"
args = ["本目录\\mcp-server.cjs"]
startup_timeout_sec = 30
tool_timeout_sec = 120

4. 将“本目录”替换成此文件夹的绝对路径，并重启 Codex。
5. 首次使用或 Agent 提示需要二次认证时，双击“登录清华账号.cmd”，按提示完成认证。
6. 在 Codex 中调用 thu_login，再尝试查询课表、图书馆座位等只读功能。

预约、取消、充值等写操作不会通过 MCP 执行；请使用“清灵-EXE”安装包的网页确认界面。
MCP 包自身包含首次登录工具，不依赖“清灵-EXE”安装包。

清华账号和验证码不会写入 MCP 返回结果。
`);

console.log(`Windows MCP 连接包已生成：${release}`);
