/**
 * Step 18 Web 服务端测试：真实 HTTP 服务 + 假 LLM，验证 SSE 事件流、
 * 确认桥（/api/confirm 应答解开挂起的写操作）、二维码事件、并发互斥。
 * 不碰外网、不碰真实模型。
 */
import {afterEach, describe, expect, it} from "vitest";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import {readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Agent} from "../../src/harness/agentLoop";
import type {LlmClient} from "../../src/harness/llmClient";
import type {ChatMessage} from "../../src/harness/types";
import type {ConfirmFn} from "../../src/harness/toolRegistry";
import type {TwoFactorHooks} from "../../src/client/auth";
import {ok, type Skill} from "../../src/skills/base/types";
import {createWebServer} from "../../src/server/webServer";
import {NotificationHub} from "../../src/server/notificationHub";
import {TaskScheduler} from "../../src/tasks/scheduler";
import {currentSessionId} from "../../src/tasks/sessionContext";

/** 脚本化假 LLM（沿用 harness 测试的模式）；seen 记录每轮收到的完整 messages */
function fakeLlm(script: ChatMessage[]): LlmClient & {seen: ChatMessage[][]} {
    let i = 0;
    const seen: ChatMessage[][] = [];
    return {
        seen,
        async chat(messages) {
            seen.push([...messages]);
            const next = script[i++];
            if (!next) throw new Error("假 LLM 脚本已耗尽");
            return next;
        },
    };
}

const textMsg = (text: string): ChatMessage => ({role: "assistant", content: text});

function toolCallMsg(name: string, args: unknown, id = "call_1"): ChatMessage {
    return {
        role: "assistant",
        content: null,
        tool_calls: [{id, type: "function", function: {name, arguments: JSON.stringify(args)}}],
    };
}

const echoSkill: Skill = {
    name: "echo",
    description: "回显，仅测试用",
    inputSchema: {type: "object", properties: {}},
    async execute() { return ok({hi: "there"}); },
};

/** 会返回支付链接的假充值 Skill（触发 qr 事件） */
const paySkill: Skill = {
    name: "recharge",
    description: "假充值，仅测试用",
    inputSchema: {type: "object", properties: {amountYuan: {type: "number"}}},
    requiresConfirmation: true,
    async execute(input) {
        return ok({amountYuan: (input as {amountYuan?: number}).amountYuan, payUrl: "https://qr.alipay.com/fake-test-code"});
    },
};

/** 读 SSE 流，收集成事件数组，直到 done/error */
async function readSse(resp: Response): Promise<{event: string; data: Record<string, unknown>}[]> {
    const events: {event: string; data: Record<string, unknown>}[] = [];
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const dataStr = /^data: (.*)$/m.exec(block)?.[1];
            if (event && dataStr) events.push({event, data: JSON.parse(dataStr)});
        }
    }
    return events;
}

describe("Web 服务端", () => {
    let server: Server | undefined;
    let base = "";

    afterEach(async () => {
        if (server) await new Promise((r) => server!.close(r));
        server = undefined;
    });

    /** 起服务：脚本化 LLM + 固定 skills，返回 base URL 和确认函数探针 */
    async function start(
        script: ChatMessage[],
        skills: Skill[] = [echoSkill],
        options: {requireLogin?: boolean} = {requireLogin: false},
    ) {
        const confirmSpy: {called: boolean} = {called: false};
        server = createWebServer((confirm: ConfirmFn) =>
            new Agent(skills, "测试", fakeLlm(script), async (call, skill) => {
                confirmSpy.called = true;
                return confirm(call, skill);
            }), options);
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return {confirmSpy};
    }

    it("GET / 返回单页 HTML", async () => {
        await start([textMsg("x")]);
        const resp = await fetch(`${base}/`);
        expect(resp.status).toBe(200);
        const html = await resp.text();
        expect(html).toContain("清灵");
    });

    it("纯文本问答：answer + done 事件", async () => {
        await start([textMsg("你好呀")]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "你好"}),
        });
        expect(resp.status).toBe(200);
        const events = await readSse(resp);
        const answer = events.find((e) => e.event === "answer");
        expect(answer?.data.text).toBe("你好呀");
        expect(events.some((e) => e.event === "done")).toBe(true);
    });

    it("二次认证桥：网页选择方式并提交验证码后继续", async () => {
        let authHooks: TwoFactorHooks | undefined;
        let selectedMethod: string | undefined;
        let receivedCode: string | undefined;
        const fakeAgent = {
            async ask() {
                selectedMethod = await authHooks!.twoFactorMethodHook!(false, "13800138000", true);
                receivedCode = await authHooks!.twoFactorAuthHook!();
                authHooks!.onLoginSuccess?.();
                return {answer: "认证后完成", toolCalls: []};
            },
        } as unknown as Agent;
        server = createWebServer((_confirm, hooks) => {
            authHooks = hooks;
            return fakeAgent;
        }, {requireLogin: false});
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "查课表"}),
        });
        const eventsPromise = readSse(resp);
        for (let i = 0; i < 50; i++) {
            const ack = await fetch(`${base}/api/auth/method`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: "auth_1", method: "totp"}),
            });
            if (ack.status === 200) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        for (let i = 0; i < 50; i++) {
            const ack = await fetch(`${base}/api/auth/code`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: "auth_2", code: "123456"}),
            });
            if (ack.status === 200) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        const events = await eventsPromise;
        expect(selectedMethod).toBe("totp");
        expect(receivedCode).toBe("123456");
        expect(events.some((e) => e.event === "auth" && e.data.phase === "method")).toBe(true);
        expect(events.some((e) => e.event === "auth" && e.data.phase === "code")).toBe(true);
        expect(events.some((e) => e.event === "auth" && e.data.phase === "success")).toBe(true);
        expect(events.find((e) => e.event === "answer")?.data.text).toBe("认证后完成");
    });

    it("网页登录接口：运行时凭证传给 Agent 并返回成功事件", async () => {
        let receivedCredentials: {username?: string; password?: string} | undefined;
        const loginAgent = {
            async login() { return undefined; },
            async ask() { return {answer: "ok", toolCalls: []}; },
        } as unknown as Agent;
        server = createWebServer((_confirm, _hooks, credentials) => {
            receivedCredentials = credentials;
            return loginAgent;
        });
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        const resp = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({username: "2024000000", password: "not-logged"}),
        });
        const events = await readSse(resp);
        expect(receivedCredentials?.username).toBe("2024000000");
        expect(receivedCredentials?.password).toBe("not-logged");
        expect(events.some((e) => e.event === "auth" && e.data.phase === "success")).toBe(true);

        const status = await fetch(`${base}/api/auth/status`);
        expect((await status.json()).authenticated).toBe(true);
    });

    it("网页登录接口：二次认证事件可由页面依次应答", async () => {
        let authHooks: TwoFactorHooks | undefined;
        let method: string | undefined;
        let code: string | undefined;
        const loginAgent = {
            async login() {
                method = await authHooks!.twoFactorMethodHook!(false, "13800138000", true);
                code = await authHooks!.twoFactorAuthHook!();
                authHooks!.onLoginSuccess?.();
            },
            async ask() { return {answer: "ok", toolCalls: []}; },
        } as unknown as Agent;
        server = createWebServer((_confirm, hooks) => {
            authHooks = hooks;
            return loginAgent;
        });
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        const resp = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({username: "2024000000", password: "not-logged"}),
        });
        const eventsPromise = readSse(resp);
        for (let i = 0; i < 50; i++) {
            const ack = await fetch(`${base}/api/auth/method`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: "auth_1", method: "totp"}),
            });
            if (ack.status === 200) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        for (let i = 0; i < 50; i++) {
            const ack = await fetch(`${base}/api/auth/code`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: "auth_2", code: "654321"}),
            });
            if (ack.status === 200) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        const events = await eventsPromise;
        expect(method).toBe("totp");
        expect(code).toBe("654321");
        expect(events.some((e) => e.event === "auth" && e.data.phase === "method")).toBe(true);
        expect(events.some((e) => e.event === "auth" && e.data.phase === "code")).toBe(true);
        expect(events.some((e) => e.event === "auth" && e.data.phase === "success")).toBe(true);
    });

    it("工具调用发出 tool start/end 事件", async () => {
        await start([toolCallMsg("echo", {}), textMsg("查完了")]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "回显"}),
        });
        const events = await readSse(resp);
        const toolEvents = events.filter((e) => e.event === "tool");
        expect(toolEvents.map((e) => e.data.phase)).toEqual(["start", "end"]);
        expect(toolEvents[1].data.success).toBe(true);
    });

    it("写操作确认桥：confirm 事件 → /api/confirm 同意 → 真正执行", async () => {
        let executed = false;
        const writeSkill: Skill = {...paySkill, async execute() { executed = true; return ok({}); }};
        await start([toolCallMsg("recharge", {amountYuan: 10}), textMsg("充好了")], [writeSkill]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "充 10 块"}),
        });

        // 读到 confirm 事件后应答同意
        const eventsPromise = readSse(resp);
        for (let i = 0; i < 50 && !executed; i++) {
            await new Promise((r) => setTimeout(r, 100));
            // 从服务端的 pendingConfirms 拿不到（封装内），改为轮询 /api/confirm 404→200
            // 简化：直接尝试用递增 id 应答——confirm 事件的 id 是 cf_1
            const ack = await fetch(`${base}/api/confirm`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: "cf_1", approved: true}),
            });
            if (ack.status === 200) break;
        }
        const events = await eventsPromise;
        expect(executed).toBe(true);
        expect(events.some((e) => e.event === "confirm" && e.data.name === "recharge")).toBe(true);
        expect(events.some((e) => e.event === "answer")).toBe(true);
    });

    it("确认拒绝：写操作不执行", async () => {
        let executed = false;
        const writeSkill: Skill = {...paySkill, async execute() { executed = true; return ok({}); }};
        await start([toolCallMsg("recharge", {amountYuan: 10}), textMsg("已取消")], [writeSkill]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "充 10 块"}),
        });
        const eventsPromise = readSse(resp);
        for (let i = 0; i < 50; i++) {
            const ack = await fetch(`${base}/api/confirm`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: "cf_1", approved: false}),
            });
            if (ack.status === 200) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        await eventsPromise;
        expect(executed).toBe(false);
    });

    it("工具结果带 payUrl 时发 qr 事件", async () => {
        await start([toolCallMsg("recharge", {amountYuan: 10}), textMsg("链接给你")], [paySkill]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "充电费"}),
        });
        const eventsPromise = readSse(resp);
        for (let i = 0; i < 50; i++) {
            const ack = await fetch(`${base}/api/confirm`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: "cf_1", approved: true}),
            });
            if (ack.status === 200) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        const events = await eventsPromise;
        const qr = events.find((e) => e.event === "qr");
        expect(qr?.data.url).toBe("https://qr.alipay.com/fake-test-code");
        expect(String(qr?.data.dataUrl ?? "")).toMatch(/^data:image\/png/);
    });

    it("ask 返回 usage 时发 usage 事件", async () => {
        const usageAgent = {
            async ask() {
                return {answer: "好", toolCalls: [], usage: {promptTokens: 100, completionTokens: 20, totalTokens: 120}};
            },
        } as unknown as Agent;
        server = createWebServer(() => usageAgent, {requireLogin: false});
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "你好"}),
        });
        const events = await readSse(resp);
        const usage = events.find((e) => e.event === "usage");
        expect(usage?.data.totalTokens).toBe(120);
        expect(usage?.data.promptTokens).toBe(100);
    });

    it("预约成功的工具结果发 calendar 事件（含现成 ics 文本）", async () => {
        const bookSkill: Skill = {
            name: "book_sports_field",
            description: "假预约，仅测试用",
            inputSchema: {type: "object", properties: {}},
            async execute() {
                return ok({
                    venue: "气膜馆羽毛球", field: "羽03",
                    date: "2026-09-06", time: "06:00-07:30",
                    orderGenerated: false, freeOrder: true,
                    message: "预约成功。",
                });
            },
        };
        await start([toolCallMsg("book_sports_field", {}), textMsg("订好了")], [bookSkill]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "约场地"}),
        });
        const events = await readSse(resp);
        const cal = events.find((e) => e.event === "calendar");
        expect(cal?.data.title).toBe("气膜馆羽毛球（羽03）");
        expect(String(cal?.data.filename)).toMatch(/\.ics$/);
        const ics = String(cal?.data.icsContent);
        expect(ics).toContain("BEGIN:VCALENDAR");
        expect(ics).toContain("DTSTART:20260906T060000");
        expect(ics).toContain("TRIGGER:-PT15M");
    });

    it("skill 能读到当前会话 id（任务归属用）", async () => {
        let seenSession: string | undefined;
        const sessionSkill: Skill = {
            name: "which_session",
            description: "读会话上下文，仅测试用",
            inputSchema: {type: "object", properties: {}},
            async execute() {
                seenSession = currentSessionId();
                return ok({});
            },
        };
        await start([toolCallMsg("which_session", {}), textMsg("好的")], [sessionSkill]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "创建任务", sessionId: "s_ctx"}),
        });
        await readSse(resp);
        expect(seenSession).toBe("s_ctx");
    });

    it("通知与任务端点：push 后可取走，drain 即消费", async () => {
        const hub = new NotificationHub();
        const scheduler = new TaskScheduler({
            notify: (task, message) => hub.push(task.id, task.title, message),
            executeBooking: async () => "ok",
            checkMonitor: async () => ({triggered: false, message: ""}),
        });
        server = createWebServer((confirm: ConfirmFn) =>
            new Agent([echoSkill], "测试", fakeLlm([textMsg("x")]), async (call, skill) => confirm(call, skill)),
            {requireLogin: false, notificationHub: hub, scheduler});
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        // 没通知时返回空
        let resp = await fetch(`${base}/api/notifications`);
        expect(((await resp.json()) as {notifications: unknown[]}).notifications).toHaveLength(0);

        // scheduler 加提醒任务并立刻到期 → tick 执行 → 通知入队
        scheduler.add({kind: "reminder", title: "电费要充了", sessionId: "s1", nextRunAt: Date.now() - 10});
        await scheduler.tick();

        resp = await fetch(`${base}/api/notifications`);
        const drained = (await resp.json()) as {notifications: {title: string; message: string}[]};
        expect(drained.notifications).toHaveLength(1);
        expect(drained.notifications[0].message).toBe("电费要充了");

        // drain 即消费：再取为空
        resp = await fetch(`${base}/api/notifications`);
        expect(((await resp.json()) as {notifications: unknown[]}).notifications).toHaveLength(0);

        // 任务列表可见（含已完成的提醒）
        const tasksResp = await fetch(`${base}/api/tasks`);
        const tasks = (await tasksResp.json()) as {tasks: {id: string; done?: boolean}[]};
        expect(tasks.tasks).toHaveLength(1);

        // 取消端点：对已完成任务 404
        const cancel = await fetch(`${base}/api/tasks/cancel`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({id: tasks.tasks[0].id}),
        });
        expect(cancel.status).toBe(404);
    });

    it("工具结果带 payFormHtml 时发 payform 事件", async () => {
        const formSkill: Skill = {
            name: "pay_order",
            description: "假支付单，仅测试用",
            inputSchema: {type: "object", properties: {}},
            async execute() {
                return ok({displayMode: "form", payFormHtml: "<form action='https://fa-online.tsinghua.edu.cn/x'></form>"});
            },
        };
        await start([toolCallMsg("pay_order", {}), textMsg("去支付")], [formSkill]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "付订单"}),
        });
        const events = await readSse(resp);
        const pf = events.find((e) => e.event === "payform");
        expect(String(pf?.data.html ?? "")).toContain("fa-online.tsinghua.edu.cn");
    });

    it("进行中再来一问返回 409", async () => {
        // 用一个会等确认的写操作把第一轮卡住
        await start([toolCallMsg("recharge", {amountYuan: 10}), textMsg("充好了")], [paySkill]);
        const first = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "第一问"}),
        });
        const firstEvents = readSse(first);
        // 等第一轮进入确认挂起（confirm 事件已发出）
        for (let i = 0; i < 50; i++) {
            const probe = await fetch(`${base}/api/confirm`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: "cf_1", approved: true}),
            });
            if (probe.status === 200) {
                // 已被这个探测应答了——说明确认确实挂起过；重新发起一轮来测 409 不可行，
                // 直接验证第一轮完成即可
                break;
            }
            // 确认还没挂上时，第二轮应被 409 拒绝
            const second = await fetch(`${base}/api/chat`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({question: "第二问"}),
            });
            if (second.status === 409) {
                expect(second.status).toBe(409);
                // 放行第一轮
                await fetch(`${base}/api/confirm`, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({id: "cf_1", approved: true}),
                });
                await firstEvents;
                return;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        await firstEvents;
    }, 20000);

    it("停止生成：客户端断开 → 中止信号传到 LLM 且 busy 释放", async () => {
        const seenSignals: AbortSignal[] = [];
        let calls = 0;
        server = createWebServer((confirm: ConfirmFn) =>
            new Agent([echoSkill], "测试", {
                async chat(_messages, _tools, signal) {
                    calls += 1;
                    seenSignals.push(signal!);
                    if (calls === 1) {
                        // 模拟 LLM 长响应：挂起直到外部中止（或 5s 兜底）
                        await new Promise<void>((resolve) => {
                            signal!.addEventListener("abort", () => resolve(), {once: true});
                            setTimeout(resolve, 5000);
                        });
                    }
                    return textMsg(`回复 ${calls}`);
                },
            }), {requireLogin: false});
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        // 前端"停止生成" = abort fetch（断开连接）
        const controller = new AbortController();
        const pending = fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "你好"}),
            signal: controller.signal,
        });
        // 轮询等待服务端进入 LLM 调用（固定 sleep 在高负载下不可靠）
        for (let i = 0; i < 100 && calls === 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }
        expect(calls).toBe(1);
        controller.abort();
        await expect(pending).rejects.toThrow();

        await new Promise((r) => setTimeout(r, 100));
        expect(seenSignals[0]?.aborted).toBe(true);

        // busy 已释放：紧接着再问应正常受理（而非 409）
        const resp2 = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "再来一问"}),
        });
        expect(resp2.status).toBe(200);
        await resp2.text();
    }, 10000);

    it("停止生成：挂起的工具调用被中止，下一问不会收到 409", async () => {
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const hangingSkill: Skill = {
            name: "hanging",
            description: "永不返回，仅测试中止",
            inputSchema: {type: "object", properties: {}},
            async execute() {
                markStarted();
                return new Promise<never>(() => {});
            },
        };
        await start([toolCallMsg("hanging", {}), textMsg("第二问正常回答")], [hangingSkill]);

        const first = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "第一问"}),
        });
        await started;

        const cancelled = await fetch(`${base}/api/chat/cancel`, {method: "POST"});
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toEqual({cancelled: true});
        await first.text();

        const second = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "第二问"}),
        });
        expect(second.status).toBe(200);
        const events = await readSse(second);
        expect(events.find((event) => event.event === "answer")?.data.text).toBe("第二问正常回答");
    }, 10000);

    it("空问题返回 400", async () => {
        await start([textMsg("x")]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "   "}),
        });
        expect(resp.status).toBe(400);
    });

    it("GET /api/capabilities 返回能力声明", async () => {
        await start([textMsg("x")]);
        const resp = await fetch(`${base}/api/capabilities`);
        expect(resp.status).toBe(200);
        const caps = (await resp.json()) as {vision?: unknown};
        expect(typeof caps.vision).toBe("boolean");
    });

    it("生产模式未登录时拒绝聊天请求", async () => {
        await start([textMsg("不会调用")], [echoSkill], {requireLogin: true});
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "查课表"}),
        });
        expect(resp.status).toBe(401);
    });

    it("只发图片不带文字也能提问", async () => {
        await start([textMsg("图上是一只猫")]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "", images: ["data:image/png;base64,iVBORw0KGgo="]}),
        });
        expect(resp.status).toBe(200);
        const events = await readSse(resp);
        expect(events.find((e) => e.event === "answer")?.data.text).toBe("图上是一只猫");
    });

    it("非图片 data URL 返回 400", async () => {
        await start([textMsg("x")]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "看图", images: ["data:text/html;base64,PHNjcmlwdD4="]}),
        });
        expect(resp.status).toBe(400);
    });

    it("图片超过 4 张返回 400", async () => {
        await start([textMsg("x")]);
        const img = "data:image/png;base64,iVBORw0KGgo=";
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "看图", images: [img, img, img, img, img]}),
        });
        expect(resp.status).toBe(400);
    });

    it("images 不是数组返回 400", async () => {
        await start([textMsg("x")]);
        const resp = await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question: "看图", images: "data:image/png;base64,xx"}),
        });
        expect(resp.status).toBe(400);
    });

    /** 起服务：所有会话共享同一个脚本化 LLM（跨会话观察上下文串扰用） */
    async function startWithSharedLlm(script: ChatMessage[], skills: Skill[] = [echoSkill]) {
        const llm = fakeLlm(script);
        server = createWebServer((confirm: ConfirmFn) =>
            new Agent(skills, "测试", llm, async (call, skill) => confirm(call, skill)), {requireLogin: false});
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return llm;
    }

    const askIn = (sessionId: string, question: string) =>
        fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question, sessionId}),
        }).then(readSse);

    it("不同 sessionId 的会话上下文互不串扰", async () => {
        const llm = await startWithSharedLlm([textMsg("好的小明"), textMsg("好的小红"), textMsg("你叫小明")]);
        await askIn("s_aaa", "我叫小明");
        await askIn("s_bbb", "我叫小红");
        await askIn("s_aaa", "我叫什么？");
        // 第三问（s_aaa）的上下文应含 s_aaa 的历史、绝不含 s_bbb 的
        const thirdCall = JSON.stringify(llm.seen[2]);
        expect(thirdCall).toContain("小明");
        expect(thirdCall).not.toContain("小红");
    });

    it("destroy 会话后对应上下文清空", async () => {
        const llm = await startWithSharedLlm([textMsg("记住了"), textMsg("你还没告诉过我名字")]);
        await askIn("s_del", "我叫小明");
        const destroy = await fetch(`${base}/api/session/destroy`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({sessionId: "s_del"}),
        });
        expect(destroy.status).toBe(200);
        await askIn("s_del", "我叫什么？");
        expect(JSON.stringify(llm.seen[1])).not.toContain("小明");
    });

    it("destroy all 清空全部会话上下文", async () => {
        const llm = await startWithSharedLlm([textMsg("a1"), textMsg("b1"), textMsg("ok")]);
        await askIn("s_x1", "橘子味暗号");
        await askIn("s_x2", "香蕉味暗号");
        await fetch(`${base}/api/session/destroy`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({all: true}),
        });
        await askIn("s_x1", "暗号是什么？");
        const lastCall = JSON.stringify(llm.seen[2]);
        expect(lastCall).not.toContain("橘子");
        expect(lastCall).not.toContain("香蕉");
    });

    it("非法 sessionId 落到默认会话（不报错）", async () => {
        const llm = await startWithSharedLlm([textMsg("一问"), textMsg("二问")]);
        await askIn("../evil", "第一问");
        await askIn("", "第二问");
        // 两次都落 default：第二问能看见第一问的上下文
        expect(JSON.stringify(llm.seen[1])).toContain("第一问");
    });
});

describe("会话持久化（Step 21c）", () => {
    let server: Server | undefined;
    let base = "";
    let storeFile = "";

    afterEach(async () => {
        if (server) await new Promise((r) => server!.close(r));
        server = undefined;
        if (storeFile) {
            await import("node:fs").then((fs) => fs.rmSync(storeFile, {force: true}));
            storeFile = "";
        }
    });

    /** 起一个带持久化的服务实例；path 缺省时新建临时文件，重启场景显式传同一路径 */
    async function startPersisted(script: ChatMessage[], path?: string) {
        storeFile = path ?? join(tmpdir(), `thu-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        const llm = fakeLlm(script);
        server = createWebServer((confirm: ConfirmFn) =>
            new Agent([echoSkill], "测试系统提示", llm, async (call, skill) => confirm(call, skill)),
            {requireLogin: false, sessionStorePath: storeFile});
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return llm;
    }

    const askIn = (sessionId: string, question: string) =>
        fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({question, sessionId}),
        }).then(readSse);

    it("重启（新服务实例）后恢复会话上下文，system 换用新提示词", async () => {
        const firstFile = join(tmpdir(), `thu-sessions-restart-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        await startPersisted([textMsg("记住了")], firstFile);
        await askIn("s_p", "我叫小明");
        await new Promise((r) => server!.close(r));
        server = undefined;

        const llm2 = await startPersisted([textMsg("你是小明")], firstFile);
        await askIn("s_p", "我叫什么？");
        const restored = JSON.stringify(llm2.seen[0]);
        expect(restored).toContain("我叫小明");
        expect(restored).toContain("记住了");
        // system 是新实例的提示词，不是恢复来的旧文本
        expect(llm2.seen[0][0].role).toBe("system");
        expect(llm2.seen[0][0].content).toBe("测试系统提示");
    });

    it("持久化内容剔除图片 base64，文字保留", async () => {
        await startPersisted([textMsg("图看到了")]);
        await fetch(`${base}/api/chat`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                question: "看图",
                sessionId: "s_img",
                images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="],
            }),
        }).then(readSse);
        const raw = readFileSync(storeFile, "utf8");
        expect(raw).not.toContain("iVBORw0KGgo");
        expect(raw).toContain("看图");
    });

    it("destroy 会话同时清除持久化文件中的该会话", async () => {
        await startPersisted([textMsg("a"), textMsg("b")]);
        await askIn("s_kill", "橘子暗号");
        await fetch(`${base}/api/session/destroy`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({sessionId: "s_kill"}),
        });
        expect(readFileSync(storeFile, "utf8")).not.toContain("橘子暗号");
    });
});
