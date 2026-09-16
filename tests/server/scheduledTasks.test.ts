import {afterEach, describe, expect, it, vi} from "vitest";
import type {Server} from "node:http";
import type {AddressInfo} from "node:net";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Agent} from "../../src/harness/agentLoop";
import type {LlmClient} from "../../src/harness/llmClient";
import type {ChatMessage} from "../../src/harness/types";
import type {Skill} from "../../src/skills/base/types";
import {createWebServer} from "../../src/server/webServer";
import type {ScheduledSnapshot} from "../../src/tasks/scheduledTypes";
import type {WorkspaceData} from "../../src/shared/workspace";

let server: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
    if (directory) { rmSync(directory, {recursive: true, force: true}); directory = undefined; }
    vi.unstubAllEnvs();
});

async function start(options: {llm?: LlmClient; skills?: Skill[]; requireLogin?: boolean; persistent?: boolean} = {}) {
    vi.stubEnv("UI_TOKEN", "");
    if (options.persistent) directory ??= mkdtempSync(join(tmpdir(), "scheduled-api-"));
    const llm = options.llm ?? {chat: async () => ({role: "assistant" as const, content: "今天有两节课。"})};
    server = createWebServer(confirm => new Agent(options.skills ?? [], "Test system", llm, confirm), {
        requireLogin: options.requireLogin ?? false, databasePath: options.persistent ? join(directory!, "test.sqlite") : undefined,
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, data: unknown) => fetch(`${base}${path}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
    const snapshot = async () => (await (await fetch(`${base}/api/scheduled-tasks`)).json()) as ScheduledSnapshot;
    const workspace = async () => (await (await fetch(`${base}/api/workspace`)).json()) as WorkspaceData;
    const create = async (prompt = "整理今天的课表") => {
        const result = await post("/api/scheduled-tasks/create", {title: "每日课表", prompt, schedule: {frequency: "daily", time: "08:00"}});
        expect(result.status).toBe(200);
        return ((await result.json()) as ScheduledSnapshot).tasks.at(-1)!;
    };
    return {base, post, snapshot, workspace, create};
}

describe("scheduled task HTTP and conversations", () => {
    it("persists a separate background conversation, preserves selection, and resumes its actual LLM context", async () => {
        const seen: ChatMessage[][] = [];
        const f = await start({llm: {chat: async messages => { seen.push(structuredClone(messages)); return {role: "assistant", content: "已经查好课程。"}; }}});
        await f.post("/api/workspace/select", {activeId: "normal_draft"});
        const task = await f.create();
        const response = await f.post("/api/scheduled-tasks/run", {id: task.id});
        expect(response.status).toBe(202);
        await expect.poll(async () => (await f.snapshot()).runs[0].status).toBe("completed");
        const first = await f.workspace();
        expect(first.history.activeId).toBe("normal_draft");
        const session = first.history.sessions[0];
        expect(session).toMatchObject({scheduledTaskId: task.id, title: task.title});
        expect(session.messages.at(-1)?.text).toBe("已经查好课程。");
        expect(session.messages.at(-1)?.turn?.status).toBe("completed");
        const answer = await f.post("/api/chat", {sessionId: session.id, question: "下午有空吗？"});
        expect(answer.status).toBe(200); await answer.text();
        expect(seen[1].some(message => message.content === "已经查好课程。")).toBe(true);
        const after = await f.workspace();
        expect(after.history.sessions[0].scheduledTaskId).toBe(task.id);
        // An older browser snapshot cannot strip task provenance and pollute the sidebar.
        const stale = structuredClone(after.history);
        delete stale.sessions[0].scheduledTaskId;
        delete stale.sessions[0].scheduledRunId;
        await f.post("/api/workspace/history", {history: stale});
        expect((await f.workspace()).history.sessions[0].scheduledTaskId).toBe(task.id);
    });

    it("never auto-approves a write, including with full-access preferences, and permits later interactive approval", async () => {
        let writes = 0;
        const skill: Skill = {name: "test_write", description: "test", inputSchema: {}, requiresConfirmation: true,
            execute: async () => { writes++; return {success: true}; }};
        let call = 0;
        const f = await start({skills: [skill], llm: {chat: async () => ++call === 1 ? {
            role: "assistant", content: null, tool_calls: [{id: "write", type: "function", function: {name: skill.name, arguments: "{}"}}],
        } : {role: "assistant", content: "请打开会话确认操作。"}}});
        await f.post("/api/workspace/preferences", {accessMode: "full-access"});
        const task = await f.create("测试需要确认的写操作");
        await f.post("/api/scheduled-tasks/run", {id: task.id});
        await expect.poll(async () => (await f.snapshot()).runs[0].status).toBe("needs_attention");
        expect(writes).toBe(0);
        const run = (await f.snapshot()).runs[0];
        call = 0;
        const answer = await f.post("/api/chat", {sessionId: run.sessionId, question: "确认执行刚才的操作", accessMode: "request-approval"});
        const reader = answer.body!.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (!text.includes("event: confirm")) text += decoder.decode((await reader.read()).value);
        const confirmation = JSON.parse(/event: confirm\ndata: (.*)/.exec(text)![1]) as {id: string};
        await f.post("/api/confirm", {id: confirmation.id, approved: true});
        while (!(await reader.read()).done) { /* Drain the response before closing the server. */ }
        expect(writes).toBe(1);
    });

    it("blocks overlapping runs and chat, stops a run, and retains an interrupted timeline", async () => {
        const f = await start({llm: {chat: async (_messages, _tools, signal) => new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), {once: true});
        })}});
        const task = await f.create();
        await f.post("/api/scheduled-tasks/run", {id: task.id});
        const run = (await f.snapshot()).runs[0];
        expect((await f.post("/api/scheduled-tasks/run", {id: task.id})).status).toBe(409);
        expect((await f.post("/api/chat", {sessionId: run.sessionId, question: "继续"})).status).toBe(409);
        expect((await f.post("/api/scheduled-tasks/delete", {id: task.id})).status).toBe(409);
        expect((await f.post("/api/scheduled-tasks/stop", {id: run.id})).status).toBe(200);
        await expect.poll(async () => (await f.snapshot()).runs[0].status).toBe("cancelled");
        expect((await f.workspace()).history.sessions[0].messages.at(-1)?.turn?.status).toBe("cancelled");
    });

    it("enforces login, JSON validation, and same-origin mutations", async () => {
        const f = await start({requireLogin: true});
        expect((await fetch(`${f.base}/api/scheduled-tasks`)).status).toBe(401);
        expect((await f.post("/api/scheduled-tasks/create", {})).status).toBe(401);
        expect((await f.post("/api/tasks/cancel", {id: "task"})).status).toBe(401);
    });

    it("rejects cross-origin and malformed input, and keeps history after task deletion", async () => {
        const f = await start();
        expect((await fetch(`${f.base}/api/scheduled-tasks/create`, {method: "POST", headers: {"Content-Type": "application/json", Origin: "https://example.com"}, body: "{}"})).status).toBe(403);
        expect((await f.post("/api/scheduled-tasks/create", {title: "invalid"})).status).toBe(400);
        const task = await f.create();
        await f.post("/api/scheduled-tasks/run", {id: task.id});
        await expect.poll(async () => (await f.snapshot()).runs[0].status).toBe("completed");
        const run = (await f.snapshot()).runs[0];
        await f.post("/api/scheduled-tasks/delete", {id: task.id});
        expect((await f.snapshot()).tasks).toHaveLength(0);
        expect((await f.snapshot()).runs).toHaveLength(1);
        expect((await f.workspace()).history.sessions).toHaveLength(1);
        await f.post("/api/scheduled-tasks/delete-run", {id: run.id});
        expect((await f.snapshot()).runs).toHaveLength(0);
        expect((await f.workspace()).history.sessions).toHaveLength(0);
    });

    it("restores task definitions, executions and resumable context from SQLite after restart", async () => {
        let f = await start({persistent: true});
        const task = await f.create();
        await f.post("/api/scheduled-tasks/run", {id: task.id});
        await expect.poll(async () => (await f.snapshot()).runs[0].status).toBe("completed");
        server!.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve()));
        // The close hook waits for background work before closing the database.
        await new Promise(resolve => setImmediate(resolve));
        const seen: ChatMessage[][] = [];
        f = await start({persistent: true, llm: {chat: async messages => { seen.push(messages); return {role: "assistant", content: "继续回答"}; }}});
        expect((await f.snapshot()).tasks[0].id).toBe(task.id);
        const run = (await f.snapshot()).runs[0];
        expect(run.status).toBe("completed");
        await (await f.post("/api/chat", {sessionId: run.sessionId, question: "继续说明"})).text();
        expect(seen[0].some(message => message.content === "今天有两节课。")).toBe(true);
    });
});
