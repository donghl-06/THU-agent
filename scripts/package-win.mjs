import {cp, mkdir, rm, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "release", "清华小助手");
const app = join(release, "app");
const runtime = join(release, "runtime");
const launcherProject = join(root, "packaging", "WindowsLauncher", "WindowsLauncher.csproj");
const launcherPublish = join(root, "packaging", "WindowsLauncher", "bin", "Release", "net8.0-windows", "win-x64", "publish");
const seaLauncher = join(root, "packaging", "sea-launcher.cjs");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

await rm(join(root, "release"), {recursive: true, force: true});
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
    await cp(join(launcherPublish, "清华小助手.exe"), join(release, "清华小助手.exe"));
    hasTrayLauncher = true;
} else {
    const seaConfig = join(release, "sea-config.json");
    const seaBlob = join(release, "sea-prep.blob");
    const launcherExe = join(release, "清华小助手.exe");
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
    ? "5. 退出程序请右键任务栏托盘中的清华小助手图标，选择“退出”。"
    : "5. 当前启动器不含托盘菜单；退出程序时，请在任务管理器中结束本目录下的 Node.js 进程。";
await writeFile(join(release, "README.txt"), `清华小助手（Windows 便携版）

1. 将本文件夹中的 .env.example 复制为 .env。
2. 打开 .env，至少填写 LLM_API_KEY；按需填写 LLM_BASE_URL、LLM_MODEL。
3. 双击“清华小助手.exe”，程序会自动启动服务并打开浏览器。
4. 在网页右上角点击“登录”，输入清华 Info 学号、密码和二次验证码。
${exitInstructions}

清华账号和验证码不会写入文件。
程序只监听本机 127.0.0.1，不会对局域网开放。
`);

console.log(`Windows 发布包已生成：${release}`);
