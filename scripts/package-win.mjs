import {cp, mkdir, rm, writeFile} from "node:fs/promises";
import {execFileSync, spawn} from "node:child_process";
import net from "node:net";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "release", "清灵-EXE");
const app = join(release, "app");
const runtime = join(release, "runtime");
const launcherProject = join(root, "packaging", "WindowsLauncher", "WindowsLauncher.csproj");
const launcherPublish = join(root, "packaging", "WindowsLauncher", "bin", "Release", "net8.0-windows", "win-x64", "publish");
const seaLauncher = join(root, "packaging", "sea-launcher.cjs");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

await rm(release, {recursive: true, force: true});
await mkdir(runtime, {recursive: true});

execFileSync(pnpmCommand, ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    ...(process.platform === "win32" ? {shell: true} : {}),
});
execFileSync(pnpmCommand, ["--filter", ".", "deploy", "--prod", "--legacy", app], {
    cwd: root,
    stdio: "inherit",
    ...(process.platform === "win32" ? {shell: true} : {}),
});
await cp(join(root, "dist"), join(app, "dist"), {recursive: true});
// EXE 包是独立的网页聊天模式，不携带 MCP 连接入口。
await rm(join(app, "dist", "scripts", "mcp-server.cjs"), {force: true});
await rm(join(app, "dist", "scripts", "mcp-login.cjs"), {force: true});
await cp(join(root, "openssl.cnf"), join(release, "openssl.cnf"));
await cp(join(root, ".env.example"), join(release, ".env.example"));
await cp(process.execPath, join(runtime, "node.exe"));

let dotnetSdk = "";
let hasTrayLauncher = false;
try {
    dotnetSdk = execFileSync("dotnet", ["--list-sdks"], {encoding: "utf8"});
} catch {}
if (dotnetSdk.trim()) {
    execFileSync("dotnet", [
        "publish", launcherProject,
        "-c", "Release",
        "-r", "win-x64",
        "--self-contained", "true",
        "-p:PublishSingleFile=true",
        "-p:IncludeNativeLibrariesForSelfExtract=true",
        "-p:DebugType=None",
        "-o", launcherPublish,
    ], {cwd: root, stdio: "inherit"});
    await cp(join(launcherPublish, "清灵.exe"), join(release, "清灵.exe"));
    hasTrayLauncher = true;
} else {
    const seaConfig = join(release, "sea-config.json");
    const seaBlob = join(release, "sea-prep.blob");
    const launcherExe = join(release, "清灵.exe");
    await writeFile(seaConfig, JSON.stringify({
        main: seaLauncher,
        output: seaBlob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
    }, null, 2));
    execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], {cwd: root, stdio: "inherit"});
    await cp(process.execPath, launcherExe);
    execFileSync(process.execPath, [
        join(root, "node_modules", "postject", "dist", "cli.js"),
        launcherExe,
        "NODE_SEA_BLOB",
        seaBlob,
        "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ], {cwd: root, stdio: "inherit"});
    await rm(seaConfig, {force: true});
    await rm(seaBlob, {force: true});
}
const exitInstructions = hasTrayLauncher
    ? "5. 退出程序请右键任务栏托盘中的清灵图标，选择“退出”。"
    : "5. 当前启动器不含托盘菜单；退出程序时，请在任务管理器中结束本目录下的 Node.js 进程。";
await writeFile(join(release, "README.txt"), `清灵（Windows 便携版）

1. 将本文件夹中的 .env.example 复制为 .env。
2. 打开 .env，填写 LLM_API_KEY；按需填写 LLM_BASE_URL、LLM_MODEL。清华账号也可以直接在网页右上角登录时填写。
3. 双击“清灵.exe”，程序会自动启动服务并打开浏览器。
4. 在网页右上角点击“登录”，输入清华 Info 学号、密码和二次验证码。
${exitInstructions}

清华账号和验证码不会写入文件。
程序只监听本机 127.0.0.1，不会对局域网开放。
如需在局域网内（如手机）访问：在 .env 里配置 UI_TOKEN=自定义口令，
然后同一 WiFi 的设备访问 http://<本机IP>:3457，输入该口令即可。
`);

console.log(`Windows 发布包已生成：${release}`);

// ===== 冒烟验证：用打包产物自己起一次服务，探活 /api/capabilities =====
// 启动器就靠这个端点判断"服务就绪"，这里跑通了才报打包成功——
// 骨架契约（入口文件、capabilities 端点等）被无意破坏时当场暴露，而不是发出去才发现。
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
const smoke = spawn(join(runtime, "node.exe"), [join(app, "dist", "scripts", "step18-web.cjs")], {
    cwd: release,
    env: {...process.env, PORT: String(smokePort), HOST: "127.0.0.1", OPENSSL_CONF: join(release, "openssl.cnf")},
    stdio: ["ignore", "pipe", "pipe"],
});
let smokeOutput = "";
smoke.stdout.on("data", (chunk) => { smokeOutput += chunk; });
smoke.stderr.on("data", (chunk) => { smokeOutput += chunk; });
let smokeOk = false;
for (let i = 0; i < 60; i += 1) {
    if (smoke.exitCode !== null) break; // 进程已退出，等不等都一样
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
