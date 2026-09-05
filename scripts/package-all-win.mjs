import {execFileSync} from "node:child_process";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const run = (script) => execFileSync(pnpmCommand, ["run", script], {
    cwd: root,
    stdio: "inherit",
    ...(process.platform === "win32" ? {shell: true} : {}),
});

run("package:win:exe");
run("package:win:mcp");
console.log("两个 Windows 发布包均已生成：release/清灵-EXE 和 release/清灵-MCP");
