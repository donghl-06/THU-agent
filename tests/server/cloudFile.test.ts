/**
 * /api/cloud-file/<token> 端点测试：验证云盘媒体只经登记 token 代理，
 * 支持 Range 流式播放，用户删除预览后 token 立即失效。
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Agent} from "../../src/harness/agentLoop";
import type {LlmClient} from "../../src/harness/llmClient";
import type {ChatMessage} from "../../src/harness/types";
import {ok, type Skill} from "../../src/skills/base/types";
import {createWebServer} from "../../src/server/webServer";
import {CloudFileStore} from "../../src/utils/cloudFileStore";

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
let workDir = "";

afterEach(async () => {
    vi.unstubAllGlobals();
    if (server?.listening) await new Promise((resolve) => server!.close(() => resolve(null)));
    server = undefined;
    if (workDir) rmSync(workDir, {recursive: true, force: true});
    workDir = "";
});

async function start(store: CloudFileStore) {
    workDir = mkdtempSync(join(tmpdir(), "qingling-cloudfile-http-"));
    const indexPath = join(workDir, "index.html");
    writeFileSync(indexPath, "<html>清灵</html>");
    server = createWebServer(
        () => new Agent([echoSkill], "测试", fakeLlm, async () => true),
        {requireLogin: false, indexHtmlPath: indexPath, cloudFileStore: store},
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("/api/cloud-file 受控云盘预览", () => {
    it("代理登记过的云盘链接并转发 Range 响应", async () => {
        const store = new CloudFileStore();
        const {url} = store.put(
            "https://cloud.tsinghua.edu.cn/seafhttp/files/token/test.mp4",
            "测试录屏.mp4",
            "video",
        );
        const realFetch = globalThis.fetch;
        const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const target = String(input);
            if (target.includes("/api/cloud-file/")) return realFetch(input, init);
            expect(target).toBe("https://cloud.tsinghua.edu.cn/seafhttp/files/token/test.mp4");
            expect((init?.headers as Record<string, string>).range).toBe("bytes=0-1023");
            return new Response("partial-bytes", {
                status: 206,
                headers: {
                    "content-type": "video/mp4",
                    "content-range": "bytes 0-1023/2048",
                    "content-length": "13",
                    "accept-ranges": "bytes",
                },
            });
        });
        vi.stubGlobal("fetch", upstreamFetch);
        const base = await start(store);

        const response = await fetch(`${base}${url}`, {headers: {range: "bytes=0-1023"}});
        expect(response.status).toBe(206);
        expect(response.headers.get("content-type")).toBe("video/mp4");
        expect(response.headers.get("content-range")).toBe("bytes 0-1023/2048");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-disposition")).toContain("inline");
        expect(await response.text()).toBe("partial-bytes");
        expect(upstreamFetch).toHaveBeenCalledTimes(2);
    });

    it("删除预览只注销本地 token，之后不可再访问", async () => {
        const store = new CloudFileStore();
        const {url} = store.put(
            "https://cloud.tsinghua.edu.cn/seafhttp/files/token/test.pdf",
            "测试文件.pdf",
            "file",
        );
        const realFetch = globalThis.fetch;
        let upstreamCalls = 0;
        const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).includes("/api/cloud-file/")) return realFetch(input, init);
            upstreamCalls += 1;
            return new Response("file-bytes", {headers: {"content-type": "application/pdf"}});
        });
        vi.stubGlobal("fetch", upstreamFetch);
        const base = await start(store);

        expect((await fetch(`${base}${url}`)).status).toBe(200);
        const removed = await fetch(`${base}${url}`, {method: "DELETE"});
        expect(removed.status).toBe(200);
        expect((await fetch(`${base}${url}`)).status).toBe(404);
        expect((await fetch(`${base}${url}`, {method: "DELETE"})).status).toBe(404);
        expect(store.pendingCount).toBe(0);
        expect(upstreamCalls).toBe(1);
    });
});
