import {spawn} from "node:child_process";
import "dotenv/config";
import {createServer as createNetServer} from "node:net";
import {build, createServer} from "vite";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const port = Number(process.env.PORT ?? 3457);
const apiPort = Number(process.env.WEB_API_PORT ?? 3458);
const host = process.env.HOST ?? (process.env.WSL_DISTRO_NAME ? "0.0.0.0" : "127.0.0.1");

// Fail before starting the scheduler if either port belongs to another process.
for (const [value, address] of [[port, host], [apiPort, "127.0.0.1"]]) {
    await new Promise((resolve, reject) => {
        const probe = createNetServer();
        probe.once("error", reject);
        probe.listen(value, address, () => probe.close(resolve));
    });
}
await build({configFile});
const backend = spawn(process.execPath, ["--import", "tsx", "scripts/step18-web.ts"], {
    cwd: root,
    env: {...process.env, PORT: String(apiPort), HOST: "127.0.0.1"},
    stdio: ["ignore", "inherit", "inherit"],
});
let vite;
let closing = false;
async function close(code = 0) {
    if (closing) return;
    closing = true;
    await vite?.close();
    backend.kill("SIGTERM");
    process.exitCode = code;
}
backend.on("exit", code => { if (!closing) void close(code ?? 1); });
backend.on("error", error => { console.error(error.message); void close(1); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void close());
try {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const response = await fetch(`http://127.0.0.1:${apiPort}/api/capabilities`);
            if (response.ok) break;
        } catch { /* Wait for the API process. */ }
        if (attempt === 59 || closing) throw new Error("Web API 未能启动");
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    vite = await createServer({configFile});
    await vite.listen();
    console.log("\n清灵 React Web · Vite 热更新已就绪");
    vite.printUrls();
} catch (error) {
    console.error(error.message);
    await close(1);
}
