import {afterEach, describe, expect, it, vi} from "vitest";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Agent} from "../../src/harness/agentLoop";
import {callTaskSkill} from "../../src/client/taskSkillClient";
import {createAllSkills} from "../../src/skills";
import {runSkillCli} from "../../src/skillCli";
import {createWebServer} from "../../src/server/webServer";
import {NotificationHub} from "../../src/server/notificationHub";
import {TaskScheduler} from "../../src/tasks/scheduler";
import {TaskStore} from "../../src/tasks/taskStore";
import {createTaskSkills} from "../../src/tasks/createTaskSkills";

const token = "offline-task-bridge-test";
let server: Server | undefined;
let directory: string | undefined;

afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
    if (directory) rmSync(directory, {recursive: true, force: true});
    directory = undefined;
    vi.unstubAllEnvs();
});

async function fixture(options: {requireLogin?: boolean; noScheduler?: boolean} = {}) {
    vi.stubEnv("UI_TOKEN", token);
    directory = mkdtempSync(join(tmpdir(), "thu-task-bridge-test-"));
    const store = new TaskStore(join(directory, "tasks.json"));
    const hub = new NotificationHub();
    let now = Date.now();
    const booking = vi.fn(async () => "测试预约结果");
    const scheduler = new TaskScheduler({
        notify: (task, message) => hub.push(task.id, task.title, message, task.sessionId),
        executeBooking: booking,
        checkMonitor: async () => ({triggered: false, message: ""}),
        now: () => now,
    }, store);
    server = createWebServer(() => new Agent([], "offline", {
        chat: async () => { throw new Error("bridge must not call the LLM"); },
    }), {
        requireLogin: options.requireLogin ?? false,
        scheduler: options.noScheduler ? undefined : scheduler,
        notificationHub: hub,
        sessionStorePath: join(directory, "sessions.json"),
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const forward = (name: string, input: unknown) => callTaskSkill(name, input, {serverUrl: url, token});
    const skills = createAllSkills({taskExecutor: forward});
    return {scheduler, store, hub, url, forward, skills, booking, setNow: (value: number) => { now = value; }};
}

describe("外部 Skill → Web 常驻任务桥", () => {
    it("发现全部能力；任务确认、落盘、到点通知、结果查询与取消形成闭环", async () => {
        const f = await fixture();
        const expected = [...createAllSkills(), ...createTaskSkills()].map((skill) => skill.name);
        const listed = await runSkillCli(["list"], f.skills);
        expect((listed.body.data as {skills: {name: string}[]}).skills.map((skill) => skill.name)).toEqual(expected);
        const params = JSON.stringify({title: "测试提醒", runAt: "2099-01-01 12:00"});
        const blocked = await runSkillCli(["call", "create_reminder", "--input", params], f.skills);
        expect(blocked.body.error?.code).toBe("CONFIRMATION_REQUIRED");
        expect(f.scheduler.list()).toHaveLength(0);

        const created = await runSkillCli(["call", "create_reminder", "--input", params, "--confirmed-by-user"], f.skills);
        expect(created.body.success).toBe(true);
        const id = (created.body.data as {taskId: string}).taskId;
        expect(f.store.load().get(id)?.sessionId).toBe("external_skill");
        f.setNow(new Date(2099, 0, 1, 12, 0).getTime());
        await f.scheduler.tick();
        expect(f.hub.drain()).toEqual([expect.objectContaining({taskId: id, sessionId: "external_skill", message: "测试提醒"})]);
        const done = await f.forward("list_my_tasks", {includeFinished: true});
        expect(done.data).toMatchObject({tasks: [{id, done: true, lastMessage: "已提醒"}]});
        expect((await f.forward("list_my_tasks", {})).data).toMatchObject({tasks: []});

        await runSkillCli(["call", "create_reminder", "--input", params, "--confirmed-by-user"], f.skills);
        const pending = f.scheduler.list(false)[0];
        expect(pending).toBeDefined();
        const cancelled = await runSkillCli(["call", "cancel_task", "--input", JSON.stringify({taskId: pending.id}), "--confirmed-by-user"], f.skills);
        expect(cancelled.body.success).toBe(true);
        expect(f.store.load().get(pending.id)?.cancelled).toBe(true);
        expect(f.booking).not.toHaveBeenCalled();
    });

    it("已确认的定时预约将明确参数交给调度器，执行器仅调用一次", async () => {
        const f = await fixture();
        const input = {
            resourceName: "测试场馆", date: "2099-01-02", sessionStart: "08:00",
            fieldName: "测试01", payType: "PAY_OFFLINE", runAt: "2099-01-01 12:00",
        };
        const result = await runSkillCli(["call", "schedule_sports_booking", "--input", JSON.stringify(input), "--confirmed-by-user"], f.skills);
        expect(result.body.success).toBe(true);
        expect(f.booking).not.toHaveBeenCalled();
        f.setNow(new Date(2099, 0, 1, 12, 0).getTime());
        await f.scheduler.tick();
        await f.scheduler.tick();
        expect(f.booking).toHaveBeenCalledTimes(1);
        expect(f.booking).toHaveBeenCalledWith(expect.objectContaining({input: {
            resourceName: input.resourceName, date: input.date, sessionStart: input.sessionStart,
            fieldName: input.fieldName, payType: input.payType,
        }}));
    });

    it("服务端拒绝缺少确认、错误口令、浏览器 Origin 以及非任务工具", async () => {
        const f = await fixture();
        const body = JSON.stringify({name: "create_reminder", input: {title: "拒绝", runAt: "2099-01-01 12:00"}});
        const request = (authorization: string, origin?: string) => fetch(`${f.url}/api/skills/tasks`, {
            method: "POST", body,
            headers: {"Content-Type": "application/json", Authorization: authorization, ...(origin ? {Origin: origin} : {})},
        });
        expect(await (await request(`Bearer ${token}`)).json()).toMatchObject({error: {code: "CONFIRMATION_REQUIRED"}});
        expect((await request("Bearer wrong")).status).toBe(403);
        expect((await request(`Bearer ${token}`, f.url)).status).toBe(403);
        expect((await f.forward("book_sports_field", {})).error?.code).toBe("UNKNOWN_SKILL");
        expect((await f.forward("list_my_tasks", {includeFinished: "yes"})).error?.code).toBe("INVALID_INPUT");
        expect(f.scheduler.list()).toHaveLength(0);
        vi.stubEnv("UI_TOKEN", "");
        expect((await request(`Bearer ${token}`)).status).toBe(403);
    });

    it("服务端要求 Web 登录，未装配调度器时返回明确错误", async () => {
        const f = await fixture({requireLogin: true});
        expect((await f.forward("list_my_tasks", {})).error?.code).toBe("AUTH_REQUIRED");
    });

    it("无调度器不声称已登记任务", async () => {
        const f = await fixture({noScheduler: true});
        expect((await f.forward("create_reminder", {title: "测试", runAt: "2099-01-01 12:00"})).error?.code).toBe("SCHEDULER_UNAVAILABLE");
    });

    it("拒绝远程地址与缺少口令；服务不可用时返回错误而非成功", async () => {
        expect((await callTaskSkill("list_my_tasks", {}, {token: ""})).error?.code).toBe("TASK_SERVICE_AUTH_REQUIRED");
        for (const serverUrl of ["https://example.com", "http://127.0.0.1.evil.test", "http://user@127.0.0.1", "http://127.0.0.1/path"]) {
            expect((await callTaskSkill("list_my_tasks", {}, {token, serverUrl})).error?.code).toBe("TASK_SERVICE_CONFIG");
        }
        const f = await fixture();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        expect((await f.forward("list_my_tasks", {})).error?.code).toBe("TASK_SERVICE_UNAVAILABLE");
    });

    it("服务重定向不携带口令跟随，也不会自动重试调用", async () => {
        let calls = 0;
        server = createServer((_req, res) => {
            calls++;
            res.writeHead(302, {Location: "/another-host", "Content-Type": "application/json"});
            res.end(JSON.stringify({success: true, data: {taskId: "not-a-real-task"}}));
        });
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const result = await callTaskSkill("create_reminder", {title: "测试", runAt: "2099-01-01 12:00"}, {serverUrl, token});
        expect(result.error?.code).toBe("TASK_SERVICE_UNAVAILABLE");
        expect(calls).toBe(1);
    });
});
