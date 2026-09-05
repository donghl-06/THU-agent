/** MCP stdio 启动入口：供 Codex 的 command/args 配置调用。 */
import {dirname, join} from "node:path";
import {existsSync} from "node:fs";

const scriptDirectory = dirname(process.argv[1] ?? process.cwd());
// 源码入口、dist 入口和独立 MCP 发布包的目录层级不同；按近到远查找配置。
const candidateRoots = [
    scriptDirectory,
    join(scriptDirectory, ".."),
    join(scriptDirectory, "..", ".."),
    join(scriptDirectory, "..", "..", ".."),
    process.cwd(),
];
const envCandidates = candidateRoots.map((root) => join(root, ".env"));
const envPath = envCandidates.find((candidate) => existsSync(candidate));
if (envPath) process.env.DOTENV_CONFIG_PATH ??= envPath;
const opensslCandidates = candidateRoots.map((root) => join(root, "openssl.cnf"));
const opensslPath = opensslCandidates.find((candidate) => existsSync(candidate));
if (opensslPath) process.env.OPENSSL_CONF ??= opensslPath;

async function main(): Promise<void> {
    try {
        const {runMcpServer} = await import("../src/mcp/server");
        await runMcpServer();
    } catch (error) {
        console.error("MCP server failed to start:", error);
        process.exitCode = 1;
    }
}

void main();
