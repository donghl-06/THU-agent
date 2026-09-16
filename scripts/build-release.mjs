import {copyFile, cp, mkdir, rm} from "node:fs/promises";
import {build} from "esbuild";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {build as buildWeb} from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await rm(dist, {recursive: true, force: true});
await buildWeb({configFile: join(root, "vite.config.ts")});
await build({
    entryPoints: [
        join(root, "scripts", "step18-web.ts"),
        join(root, "scripts", "mcp-server.ts"),
        join(root, "scripts", "mcp-login.ts"),
    ],
    bundle: true,
    outdir: join(dist, "scripts"),
    platform: "node",
    format: "cjs",
    target: "node22",
    outExtension: {".js": ".cjs"},
    keepNames: true,
    legalComments: "eof",
    sourcemap: false,
    logLevel: "warning",
});

await mkdir(join(dist, "src", "server", "public"), {recursive: true});
// Vite 构建的 React 页面、带 hash 的 JS/CSS 与离线壳一起进入发行包。
await cp(
    join(root, "build", "web"),
    join(dist, "src", "server", "public"),
    {recursive: true},
);
await copyFile(join(root, "openssl.cnf"), join(dist, "openssl.cnf"));
