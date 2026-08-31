import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {cp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {basename, dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releaseRoot = join(root, "release");
const releaseName = `清华小助手-v${packageManifest.version}-win-x64`;
const release = join(releaseRoot, releaseName);
const archive = join(releaseRoot, `${releaseName}.zip`);
const checksumFile = `${archive}.sha256.txt`;
const app = join(release, "app");
const runtime = join(release, "runtime");
const licenses = join(release, "licenses");
const launcherProject = join(root, "packaging", "WindowsLauncher", "WindowsLauncher.csproj");
const launcherPublish = join(root, "packaging", "WindowsLauncher", "bin", "Release", "net8.0-windows", "win-x64", "publish");
const seaLauncher = join(root, "packaging", "sea-launcher.cjs");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runPnpm(args, options = {}) {
    return execFileSync(pnpmCommand, args, {
        cwd: root,
        stdio: "inherit",
        ...(process.platform === "win32" ? {shell: true} : {}),
        ...options,
    });
}

function safeFileName(value) {
    return value.replace(/^@/, "").replace(/[\\/:*?"<>|@]/g, "_");
}

function powerShellLiteral(value) {
    return `'${value.replaceAll("'", "''")}'`;
}

async function copyDependencyLicenses() {
    const reportText = execFileSync(pnpmCommand, ["licenses", "list", "--prod", "--json"], {
        cwd: root,
        encoding: "utf8",
        ...(process.platform === "win32" ? {shell: true} : {}),
    });
    const report = JSON.parse(reportText);
    const notices = [
        "THIRD-PARTY SOFTWARE NOTICES",
        "",
        `Node.js ${process.versions.node} runtime: https://github.com/nodejs/node/blob/v${process.versions.node}/LICENSE`,
        "",
        "Bundled JavaScript dependencies:",
        "",
    ];
    const seen = new Set();

    for (const [declaredLicense, packages] of Object.entries(report)) {
        for (const dependency of packages) {
            for (const packagePath of dependency.paths ?? []) {
                const manifestPath = join(packagePath, "package.json");
                const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
                const identity = `${manifest.name}@${manifest.version}`;
                if (seen.has(identity)) continue;
                seen.add(identity);

                const targetDirectory = join(licenses, safeFileName(identity));
                await mkdir(targetDirectory, {recursive: true});
                await cp(manifestPath, join(targetDirectory, "package.json"));

                const entries = await readdir(packagePath, {withFileTypes: true});
                let legalFiles = entries
                    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(\..*)?$/i.test(entry.name))
                    .map((entry) => entry.name);
                const readme = entries.find((entry) => entry.isFile() && /^readme(\..*)?$/i.test(entry.name));
                if (legalFiles.length === 0 && readme) legalFiles = [readme.name];
                for (const fileName of legalFiles) {
                    await cp(join(packagePath, fileName), join(targetDirectory, fileName));
                }

                const license = manifest.license ?? dependency.license ?? declaredLicense;
                const homepage = manifest.homepage ?? dependency.homepage ?? "未提供";
                const copiedFiles = ["package.json", ...legalFiles]
                    .map((fileName) => relative(release, join(targetDirectory, fileName)).replaceAll("\\", "/"))
                    .join(", ");
                notices.push(`${identity} | ${license} | ${homepage}`);
                notices.push(`  Files: ${copiedFiles}`);
            }
        }
    }

    await writeFile(join(release, "THIRD_PARTY_NOTICES.txt"), `${notices.join("\r\n")}\r\n`);
}

async function sha256(filePath) {
    const hash = createHash("sha256");
    await new Promise((resolvePromise, rejectPromise) => {
        const stream = createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", resolvePromise);
        stream.on("error", rejectPromise);
    });
    return hash.digest("hex");
}

await mkdir(releaseRoot, {recursive: true});
await rm(release, {recursive: true, force: true});
await rm(archive, {force: true});
await rm(checksumFile, {force: true});
await mkdir(app, {recursive: true});
await mkdir(runtime, {recursive: true});
await mkdir(licenses, {recursive: true});

runPnpm(["run", "build"]);
await cp(join(root, "dist"), join(app, "dist"), {recursive: true});
await cp(join(root, "openssl.cnf"), join(release, "openssl.cnf"));
await cp(join(root, ".env.example"), join(release, ".env.example"));
await cp(process.execPath, join(runtime, "node.exe"));
await copyDependencyLicenses();

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
请勿将填写过真实密钥的 .env 文件上传或转发给他人。
第三方依赖声明见 THIRD_PARTY_NOTICES.txt 和 licenses 文件夹。
`);

execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ProgressPreference = 'SilentlyContinue'; Compress-Archive -LiteralPath ${powerShellLiteral(release)} -DestinationPath ${powerShellLiteral(archive)} -CompressionLevel Optimal -Force`,
], {
    stdio: "inherit",
});
const archiveHash = await sha256(archive);
await writeFile(checksumFile, `${archiveHash} *${basename(archive)}\r\n`);

console.log(`Windows 发布目录：${release}`);
console.log(`GitHub Release 压缩包：${archive}`);
console.log(`SHA-256 校验文件：${checksumFile}`);
