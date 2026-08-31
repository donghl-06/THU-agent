#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
    pnpm,
    ["--dir", repositoryRoot, "exec", "tsx", "src/skillCli.ts", ...process.argv.slice(2)],
    {
        cwd: repositoryRoot,
        env: {...process.env, OPENSSL_CONF: resolve(repositoryRoot, "openssl.cnf")},
        stdio: "inherit",
    },
);

if (result.error) {
    process.stderr.write("无法启动 THU-agent Skill CLI；请确认 Node.js、pnpm 和项目依赖已经安装。\n");
    process.exitCode = 127;
} else {
    process.exitCode = result.status ?? 1;
}
