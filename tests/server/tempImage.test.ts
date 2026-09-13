/**
 * /api/temp-image/<token> 端点测试：真实 HTTP 服务 + 临时目录，不碰外网。
 *
 * 验证用户确认式生命周期：GET 可反复取图（不删文件）→ 用户点「已用完」
 * （DELETE）后才删本地文件 → 再 GET 404；未登录 401；未装配 imageStore 404。
 */
import {afterEach, describe, expect, it} from "vitest";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Agent} from "../../src/harness/agentLoop";
import type {LlmClient} from "../../src/harness/llmClient";
import type {ChatMessage} from "../../src/harness/types";
import {ok, type Skill} from "../../src/skills/base/types";
import {createWebServer} from "../../src/server/webServer";
import {TempImageStore} from "../../src/utils/tempImageStore";

const fakeLlm: LlmClient = {
    async chat(): Promise<ChatMessage> {
        return {role: "assistant", content: "测试"};
    },
};

const echoSkill: Skill = {
    name: "echo",
    description: "回显，仅测试用",
    inputSchema: {type: "object", properties: {}},
    async execute() { return ok({}); },
};

let server: Server | undefined;
let base = "";
let store: TempImageStore;
let workDir = "";

afterEach(async () => {
    if (server?.listening) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (workDir) rmSync(workDir, {recursive: true, force: true});
    workDir = "";
});

async function start(options: {requireLogin?: boolean; withStore?: boolean} = {}) {
    workDir = mkdtempSync(join(tmpdir(), "qingling-tmpimg-http-"));
    store = new TempImageStore(join(workDir, "tmp-images"));
    const indexPath = join(workDir, "index.html");
    writeFileSync(indexPath, "<html>清灵</html>");
    server = createWebServer(
        () => new Agent([echoSkill], "测试", fakeLlm, async () => true),
        {
            requireLogin: options.requireLogin ?? false,
            indexHtmlPath: indexPath,
            ...(options.withStore === false ? {} : {imageStore: store}),
        },
    );
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("/api/temp-image 临时图片（用户确认后删除）", () => {
    it("GET 取图不删文件，可反复取（刷新历史也能看）", async () => {
        await start();
        const {token, url} = store.put(Buffer.from("jpeg-bytes"), "image/jpeg", "二维码.jpg");
        const path = join(workDir, "tmp-images", `${token}.jpg`);

        for (let i = 0; i < 2; i++) {
            const resp = await fetch(`${base}${url}`);
            expect(resp.status).toBe(200);
            expect(resp.headers.get("content-type")).toBe("image/jpeg");
            expect(Buffer.from(await resp.arrayBuffer()).toString()).toBe("jpeg-bytes");
        }
        // 展示不删：本地文件仍在
        expect(existsSync(path)).toBe(true);
        expect(store.pendingCount).toBe(1);
    });

    it("DELETE（用户点「已用完」）后才删本地文件，之后 GET 404", async () => {
        await start();
        const {token, url} = store.put(Buffer.from("x"), "image/png", "a.png");
        const path = join(workDir, "tmp-images", `${token}.png`);
        expect((await fetch(`${base}${url}`)).status).toBe(200);

        const del = await fetch(`${base}${url}`, {method: "DELETE"});
        expect(del.status).toBe(200);
        expect(existsSync(path)).toBe(false);
        expect(store.pendingCount).toBe(0);

        expect((await fetch(`${base}${url}`)).status).toBe(404);
        // 重复 DELETE 也 404（前端视作已清理）
        expect((await fetch(`${base}${url}`, {method: "DELETE"})).status).toBe(404);
    });

    it("未知 token：GET 与 DELETE 都 404", async () => {
        await start();
        expect((await fetch(`${base}/api/temp-image/nope`)).status).toBe(404);
        expect((await fetch(`${base}/api/temp-image/nope`, {method: "DELETE"})).status).toBe(404);
    });

    it("未登录 401", async () => {
        await start({requireLogin: true});
        const {url} = store.put(Buffer.from("x"), "image/png", "a.png");
        expect((await fetch(`${base}${url}`)).status).toBe(401);
        expect((await fetch(`${base}${url}`, {method: "DELETE"})).status).toBe(401);
    });

    it("未装配 imageStore 时 404", async () => {
        await start({withStore: false});
        expect((await fetch(`${base}/api/temp-image/anything`)).status).toBe(404);
    });
});
