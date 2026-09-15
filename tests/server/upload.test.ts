/**
 * /api/upload 文件上传端点测试：真实 HTTP 服务 + 临时目录，不碰外网。
 *
 * 验证：成功落盘并返回绝对路径、文件名清洗（路径成分/控制字符）、
 * 空文件与非法文件名被拒、未登录 401。
 */
import {afterEach, describe, expect, it} from "vitest";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Agent} from "../../src/harness/agentLoop";
import type {LlmClient} from "../../src/harness/llmClient";
import type {ChatMessage} from "../../src/harness/types";
import {ok, type Skill} from "../../src/skills/base/types";
import {createWebServer} from "../../src/server/webServer";

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
let uploadDir = "";
let indexPath = "";
let workDir = "";

afterEach(async () => {
    if (server?.listening) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (workDir) rmSync(workDir, {recursive: true, force: true});
    workDir = "";
});

async function start(options: {requireLogin?: boolean} = {requireLogin: false}) {
    workDir = mkdtempSync(join(tmpdir(), "qingling-upload-test-"));
    uploadDir = join(workDir, "uploads");
    indexPath = join(workDir, "index.html");
    writeFileSync(indexPath, "<html>清灵</html>");
    server = createWebServer(
        () => new Agent([echoSkill], "测试", fakeLlm, async () => true),
        {...options, indexHtmlPath: indexPath, uploadDir},
    );
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const upload = (name: string, body: string | Buffer) =>
    fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, {
        method: "POST",
        body: typeof body === "string" ? body : new Uint8Array(body),
    });

describe("/api/upload 文件上传", () => {
    it("成功上传：落盘到 uploadDir 并返回绝对路径", async () => {
        await start();
        const resp = await upload("作业第三题.pdf", Buffer.from("%PDF-1.4 fake"));
        expect(resp.status).toBe(200);
        const data = await resp.json() as {name: string; path: string; sizeBytes: number};
        expect(data.name).toBe("作业第三题.pdf");
        expect(data.sizeBytes).toBe(13);
        expect(data.path.startsWith(uploadDir)).toBe(true);
        expect(data.path.endsWith("_作业第三题.pdf")).toBe(true);
        expect(readFileSync(data.path)).toEqual(Buffer.from("%PDF-1.4 fake"));
    });

    it("文件名清洗：剥离路径成分", async () => {
        await start();
        const resp = await upload("../../etc/passwd", "x");
        expect(resp.status).toBe(200);
        const data = await resp.json() as {name: string; path: string};
        expect(data.name).toBe("passwd");
        expect(data.path.startsWith(uploadDir)).toBe(true);
        expect(existsSync(data.path)).toBe(true);
    });

    it("空文件 400、非法文件名 400", async () => {
        await start();
        expect((await upload("a.pdf", "")).status).toBe(400);
        expect((await upload("..", "x")).status).toBe(400);
        expect((await upload("", "x")).status).toBe(400);
    });

    it("同名文件不互相覆盖（时间戳+随机前缀）", async () => {
        await start();
        const a = await (await upload("hw.pdf", "first")).json() as {path: string};
        const b = await (await upload("hw.pdf", "second")).json() as {path: string};
        expect(a.path).not.toBe(b.path);
        expect(readFileSync(a.path, "utf8")).toBe("first");
        expect(readFileSync(b.path, "utf8")).toBe("second");
    });

    it("未登录时 401", async () => {
        await start({requireLogin: true});
        const resp = await upload("a.pdf", "x");
        expect(resp.status).toBe(401);
    });
});
