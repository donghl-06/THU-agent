import {afterEach, describe, expect, it} from "vitest";
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {platform} from "node:process";
import {join} from "node:path";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import {WebDatabase} from "../../src/server/webDatabase";
import {createWebServer} from "../../src/server/webServer";
import {Agent} from "../../src/harness/agentLoop";
import type {ChatMessage} from "../../src/harness/types";

const directory = () => mkdtempSync(join(tmpdir(), "qingling-database-"));
const history = {activeId: "s_saved", deletedSessionIds: [], sessions: [{id: "s_saved", title: "旧对话", createdAt: 1,
    messages: [{id: "u", role: "user", text: "记住我的问题"}, {id: "a", role: "bot", text: "记住了"}]}]};
const folders: string[] = [];
const databases: WebDatabase[] = [];
const servers: Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const database of databases.splice(0)) database.close();
    for (const folder of folders.splice(0)) rmSync(folder, {recursive: true, force: true});
});

describe("后端 SQLite 工作区", () => {
    it("历史、偏好、身份及模型上下文重开数据库后恢复，文件权限为 0600", () => {
        const folder = directory(); folders.push(folder);
        const path = join(folder, "qingling.sqlite");
        let database = new WebDatabase(path);
        database.importBrowser(history, {theme: "dark", sound: false});
        database.put("profile", {username: "2000000001", name: "测试同学"});
        database.saveAttachment("fixture.pdf", "作业.pdf", Buffer.from("fixture"));
        database.close();
        database = new WebDatabase(path); databases.push(database);
        expect(database.history().sessions[0].messages).toHaveLength(2);
        expect(database.preferences()).toMatchObject({theme: "dark", sound: false});
        expect(database.profile()).toMatchObject({name: "测试同学"});
        expect(database.getContext("s_saved")?.[0].content).toBe("记住我的问题");
        // Windows 将 POSIX 权限映射到 ACL/只读位，statSync 会显示 0666；仅 POSIX 检查 0600。
        if (platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readFileSync(path).subarray(0, 15).toString()).toBe("SQLite format 3");
    });

    it("重复迁移幂等，数据库偏好优先，旧标签页不能复活已删除对话", () => {
        const database = new WebDatabase(); databases.push(database);
        database.savePreferences({theme: "dark"});
        database.importBrowser(history, {theme: "light"});
        database.importBrowser(history, {});
        expect(database.history().sessions[0].messages).toHaveLength(2);
        expect(database.preferences().theme).toBe("dark");
        database.deleteSession("s_saved");
        database.importBrowser(history, {});
        expect(database.history().sessions).toEqual([]);
        expect(database.getContext("s_saved")).toBeUndefined();
    });

    it("迁移失败不会部分提交，已有完整回复不会被旧客户端内容覆盖", () => {
        const database = new WebDatabase(); databases.push(database);
        expect(() => database.importBrowser(history, {theme: "purple"})).toThrow();
        expect(database.history().sessions).toEqual([]);
        database.importBrowser(history, {});
        database.updateSession("s_saved", session => ({...session, messages: session.messages.map(message => message.id === "a" ? {...message, text: "完整结果"} : message)}));
        database.importBrowser({...history, sessions: history.sessions.map(session => ({...session, updatedAt: Date.now() + 100000}))}, {});
        expect(database.history().sessions[0].messages[1].text).toBe("完整结果");
    });

    it("旧 JSON 上下文只迁移一次，意外中断的 turn 重启后保留并结束", () => {
        const folder = directory(); folders.push(folder);
        const legacy = join(folder, "sessions.json");
        const path = join(folder, "qingling.sqlite");
        writeFileSync(legacy, JSON.stringify({s_saved: [{role: "user", content: "旧上下文"}]}));
        let database = new WebDatabase(path, legacy);
        database.updateSession("s_saved", session => ({...session, messages: [{id: "a", role: "bot", text: "", turn: {
            sessionId: "s_saved", messageId: "a", startedAt: 1, status: "running", phase: "thinking",
            items: [{id: "reasoning", kind: "reasoning", text: "已经收到的思考", status: "streaming"}],
        }}]}));
        database.deleteSession("s_saved");
        database.updateSession("s_running", session => ({...session, messages: [{id: "b", role: "bot", text: "部分答案", turn: {
            sessionId: "s_running", messageId: "b", startedAt: 1, status: "running", phase: "generating",
            items: [{id: "text", kind: "text", text: "部分答案", status: "streaming"}],
        }}]}));
        database.close();
        database = new WebDatabase(path, legacy); databases.push(database);
        expect(database.getContext("s_saved")).toBeUndefined();
        expect(database.history().sessions[0].messages[0].turn?.status).toBe("error");
        expect(database.history().sessions[0].messages[0].text).toBe("部分答案");
    });

    it("无需浏览器回写：HTTP 问答、用量与模型上下文在服务重启后恢复", async () => {
        const folder = directory(); folders.push(folder);
        const path = join(folder, "qingling.sqlite");
        const seen: ChatMessage[][] = [];
        const start = async () => {
            const server = createWebServer(confirm => new Agent([], "系统", {chat: async messages => {
                seen.push([...messages]);
                return {role: "assistant", content: "后端保存的回答", usage: {promptTokens: 2, completionTokens: 3, totalTokens: 5}};
            }}, confirm), {databasePath: path, requireLogin: false});
            servers.push(server);
            await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
            return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        };
        let base = await start();
        await (await fetch(`${base}/api/chat`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({sessionId: "s_http", question: "第一问"})})).text();
        await new Promise<void>(resolve => servers.pop()!.close(() => resolve()));
        base = await start();
        const workspace = await (await fetch(`${base}/api/workspace`)).json();
        expect(workspace.history.sessions[0].messages.map((m: {text: string}) => m.text)).toEqual(["第一问", "后端保存的回答"]);
        expect(workspace.history.sessions[0].messages[1].turn.status).toBe("completed");
        await (await fetch(`${base}/api/chat`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({sessionId: "s_http", question: "第二问"})})).text();
        expect(JSON.stringify(seen[1])).toContain("第一问");
    });

    it("未登录不可读取历史、身份或写入对话；偏好字段严格校验", async () => {
        const database = new WebDatabase();
        database.importBrowser(history, {});
        database.put("profile", {username: "private-user"});
        const server = createWebServer(() => ({}) as Agent, {database}); servers.push(server);
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const workspace = await (await fetch(`${base}/api/workspace`)).json();
        expect(workspace.history.sessions).toEqual([]);
        expect(workspace.profile).toBeUndefined();
        expect((await fetch(`${base}/api/workspace/import`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({history})})).status).toBe(401);
        expect((await fetch(`${base}/api/workspace/preferences`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({sidebarWidth: -1})})).status).toBe(400);
        expect((await fetch(`${base}/api/workspace/preferences`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({theme: "dark"})})).status).toBe(200);
    });
});
