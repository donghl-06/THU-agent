const {spawn} = require("node:child_process");
const {existsSync} = require("node:fs");
const {dirname, join} = require("node:path");
const net = require("node:net");

const root = dirname(process.execPath);
const nodePath = join(root, "runtime", "node.exe");
const scriptPath = join(root, "app", "dist", "scripts", "step18-web.cjs");
const opensslPath = join(root, "openssl.cnf");

function findAvailablePort(start, count) {
    return new Promise((resolve, reject) => {
        let port = start;
        const tryNext = () => {
            if (port >= start + count) {
                reject(new Error("找不到可用的本地端口。"));
                return;
            }
            const listener = net.createServer();
            listener.once("error", () => {
                listener.close();
                port += 1;
                tryNext();
            });
            listener.listen(port, "127.0.0.1", () => {
                listener.close(() => resolve(port));
            });
        };
        tryNext();
    });
}

async function waitForServer(child, port) {
    for (let i = 0; i < 60; i += 1) {
        if (child.exitCode !== null) return false;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/api/capabilities`);
            if (response.ok) return true;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
}

async function main() {
    if (!existsSync(nodePath) || !existsSync(scriptPath) || !existsSync(opensslPath)) {
        throw new Error("程序文件不完整，请重新解压完整的清华小助手发布包。");
    }
    const port = await findAvailablePort(3457, 20);
    const child = spawn(nodePath, [scriptPath], {
        cwd: root,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {...process.env, PORT: String(port), OPENSSL_CONF: opensslPath},
    });
    child.unref();
    if (!await waitForServer(child, port)) {
        try { child.kill(); } catch {}
        throw new Error("本地服务启动失败，请检查 .env 配置和程序目录。");
    }
    spawn("cmd.exe", ["/d", "/c", "start", "", `http://127.0.0.1:${port}/`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    }).unref();
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
