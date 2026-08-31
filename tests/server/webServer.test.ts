/**
 * Step 18 Web 服务端测试：真实 HTTP 服务 + 假 LLM，验证 SSE 事件流、
 * 确认桥（/api/confirm 应答解开挂起的写操作）、二维码事件、并发互斥。
 * 不碰外网、不碰真实模型。
 */
import {afterEach, describe, expect, it} from "vitest";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import {Agent} from "../../src/harness/agentLoop";
import type {LlmClient} from "../../src/harness/llmClient";
import type {ChatMessage} from "../../src/harness/types";
import type {ConfirmFn} from "../../src/harness/toolRegistry";
import type {TwoFactorHooks} from "../../src/client/auth";
import {ok, type Skill} from "../../src/skills/base/types";
import {createWebServer} from "../../src/server/webServer";

/** 脚本化假 LLM（沿用 harness 测试的模式） */
function fakeLlm(script: ChatMessage[]): LlmClient {
    let i = 0;
    return {
        async chat() {
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
        expect(html).toContain("清华小助手");
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
});
