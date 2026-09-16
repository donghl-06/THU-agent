import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath} from "node:url";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";

export default defineConfig({
    root: fileURLToPath(new URL("./src/web", import.meta.url)),
    plugins: [react(), {
        name: "qingling-offline-shell",
        async writeBundle(options, bundle) {
            const assets = Object.keys(bundle).filter(name => /\.(js|css|svg|png|jpe?g|webp)$/.test(name)).map(name => `/${name}`);
            const version = createHash("sha256").update(assets.join("|")).digest("hex").slice(0, 12);
            const path = join(options.dir!, "service-worker.js");
            const worker = await readFile(path, "utf8");
            await writeFile(path, worker.replace('"__WEB_ASSETS__"', JSON.stringify(assets)).replace("__WEB_VERSION__", version));
        },
    }],
    build: {
        outDir: "../../build/web",
        emptyOutDir: true,
        target: "es2022",
    },
    server: {
        host: process.env.HOST ?? (process.env.WSL_DISTRO_NAME ? "0.0.0.0" : "127.0.0.1"),
        port: Number(process.env.PORT ?? 3457),
        strictPort: true,
        proxy: {"/api": {target: `http://127.0.0.1:${process.env.WEB_API_PORT ?? 3458}`, changeOrigin: true}},
        fs: {strict: true},
    },
});
