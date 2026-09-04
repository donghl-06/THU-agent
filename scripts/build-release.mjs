import {copyFile, cp, mkdir, rm} from "node:fs/promises";
import {build} from "esbuild";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await rm(dist, {recursive: true, force: true});
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
    sourcemap: false,
    logLevel: "warning",
});

await mkdir(join(dist, "src", "server", "public"), {recursive: true});
// 前端静态资源整目录带走：index.html + manifest.webmanifest + icons/（PWA 图标）
await cp(
    join(root, "src", "server", "public"),
    join(dist, "src", "server", "public"),
    {recursive: true},
);
await copyFile(join(root, "openssl.cnf"), join(dist, "openssl.cnf"));
