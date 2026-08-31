import {copyFile, mkdir, rm} from "node:fs/promises";
import {build} from "esbuild";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await rm(dist, {recursive: true, force: true});
await build({
    entryPoints: [join(root, "scripts", "step18-web.ts")],
    bundle: true,
    outfile: join(dist, "scripts", "step18-web.cjs"),
    platform: "node",
    format: "cjs",
    target: "node22",
    keepNames: true,
    legalComments: "eof",
    sourcemap: false,
    logLevel: "warning",
});

await mkdir(join(dist, "src", "server", "public"), {recursive: true});
await copyFile(
    join(root, "src", "server", "public", "index.html"),
    join(dist, "src", "server", "public", "index.html"),
);
await copyFile(join(root, "openssl.cnf"), join(dist, "openssl.cnf"));
