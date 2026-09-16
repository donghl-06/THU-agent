/** Offline UI fixture. Scheduled runs use this fake Agent; no THU clients or real LLM calls. */
import {setTimeout as delay} from "node:timers/promises";
import {createWebServer} from "../src/server/webServer";
import type {Agent} from "../src/harness/agentLoop";
import type {Skill} from "../src/skills/base/types";
import {ToolRegistry} from "../src/harness/toolRegistry";
import {WebDatabase} from "../src/server/webDatabase";
import {defaultPreferences} from "../src/shared/workspace";
import {newId} from "../src/web/lib/history";
import {createRechargeCampusCardSkill} from "../src/skills/card/rechargeCampusCard";
process.env.UI_TOKEN = "";
process.env.LLM_VISION = "1";
const fakeWrite: Skill = {name: "book_library_seat", description: "UI 测试预约", inputSchema: {}, requiresConfirmation: true, execute: async () => ({success: true})};
const fakeRecharge = createRechargeCampusCardSkill({
    rechargeCampusCardBank: async () => {},
    rechargeCampusCardQr: async () => "https://qr.alipay.com/synthetic-ui-test",
});
const database = new WebDatabase();
const server = createWebServer((confirm, authHooks, credentials) => ({
    login: async () => {
        if (credentials?.username === "2000000000") {
            await authHooks?.twoFactorMethodHook?.(true, "13800000000", true);
            await authHooks?.twoFactorAuthHook?.();
        }
        authHooks?.onLoginSuccess?.();
    },
    ask: async (question: string, options: Parameters<Agent["ask"]>[1]) => {
        const signal = options?.signal;
        if (question.includes("时序")) {
            options?.onReasoning?.("先确认今天的课程，再核对空闲时段。");
            await delay(question.includes("停止") ? 10000 : 700, undefined, {signal});
            options?.onToken?.("我先查一下今天的课表。");
            options?.onToolEvent?.({phase: "start", name: "get_schedule", toolCallId: "schedule-1"});
            options?.onToolEvent?.({phase: "start", name: "get_schedule", toolCallId: "schedule-2"});
            await delay(450, undefined, {signal});
            options?.onToolEvent?.({phase: "end", name: "get_schedule", toolCallId: "schedule-2", success: false, ms: 300});
            await delay(250, undefined, {signal});
            options?.onToolEvent?.({phase: "end", name: "get_schedule", toolCallId: "schedule-1", success: true, ms: 700});
            options?.onReasoning?.("已经获取课程，继续核对教室安排。");
            await delay(700, undefined, {signal});
            options?.onToken?.("课程已查到，我再确认一下教室。");
            options?.onToolEvent?.({phase: "start", name: "get_classroom_state", toolCallId: "classroom"});
            await delay(400, undefined, {signal});
            options?.onToolEvent?.({phase: "end", name: "get_classroom_state", toolCallId: "classroom", success: true, ms: 400});
            options?.onReasoning?.("信息已核对，整理最终安排。");
            await delay(700, undefined, {signal});
            options?.onToken?.("今天有 **2 节课**。");
            await delay(350, undefined, {signal});
            const answer = "今天有 **2 节课**。下午 15:05 后可以安排自习。";
            options?.onToken?.("下午 15:05 后可以安排自习。");
            await delay(1000, undefined, {signal});
            return {answer, toolCalls: [], usage: {promptTokens: 256, completionTokens: 128, totalTokens: 384}};
        }
        if (question.includes("错误")) throw new Error("Fixture service unavailable");
        if (question.includes("银行卡充值")) {
            const input = JSON.stringify({amountYuan: 100, method: "bank"});
            const result = await new ToolRegistry([fakeRecharge], confirm).execute({
                id: "bank_test_call", type: "function", function: {name: fakeRecharge.name, arguments: input},
            }, options?.accessMode);
            const parsed = JSON.parse(result) as {success: boolean; data?: {message: string}};
            return {
                answer: parsed.success ? parsed.data!.message : "已取消，未执行银行卡充值。",
                toolCalls: [{name: fakeRecharge.name, input, result}],
            };
        }
        if (question.includes("预约")) {
            const result = await new ToolRegistry([fakeWrite], confirm).execute({id: "test_call", type: "function", function: {name: fakeWrite.name, arguments: JSON.stringify({图书馆: "测试图书馆", 座位: "A101", 时间: "14:00–16:00"})}}, options?.accessMode);
            const approved = (JSON.parse(result) as {success: boolean}).success;
            return {answer: approved ? "测试预约已确认。" : "已取消，未执行预约。", toolCalls: []};
        }
        options?.onToolEvent?.({phase: "start", name: "get_schedule"});
        await delay(350, undefined, {signal});
        options?.onToolEvent?.({phase: "end", name: "get_schedule", success: true, ms: 350});
        const answer = "今天有 **2 节课**，已经为你整理好了。\n\n| 时间 | 课程 | 地点 |\n| --- | --- | --- |\n| 09:50–12:15 | 计算机系统概论 | 六教 6A201 |\n| 13:30–15:05 | 线性代数 | 四教 4203 |\n\n下午 15:05 后没有课程，可以安排自习或运动。";
        const pieces = question.includes("长回答") ? Array.from({length: 40}, (_, i) => `第 ${i + 1} 段测试回复。\n\n`) : answer.match(/.{1,8}|\n/g)!;
        for (const text of pieces) {
            options?.onToken?.(text);
            await delay(question.includes("停止") ? 600 : 45, undefined, {signal});
        }
        return {answer: question.includes("长回答") ? pieces.join("") : answer, toolCalls: [], usage: {promptTokens: 256, completionTokens: 128, totalTokens: 384}};
    },
    snapshotMessages: () => [],
    loadMessages: () => {},
    appendAssistantMessage: () => {},
}) as unknown as Agent, {port: 3461, database, getUserProfile: async () => ({name: "测试同学", email: "fixture@tsinghua.edu.cn"}), requireLogin: true, titleLlm: {chat: async () => ({role: "assistant", content: "今日课程安排"})}});
// Fixture-only reset; production never exposes this route.
const handlers = server.listeners("request");
server.removeAllListeners("request");
server.on("request", (req, res) => {
    if (req.url === "/__fixture/reset" && req.method === "POST") {
        database.put("history", {activeId: newId(), sessions: [], deletedSessionIds: []});
        database.put("preferences", {...defaultPreferences, sound: false});
        res.writeHead(200).end("{}");
    } else for (const handler of handlers) handler.call(server, req, res);
});
server.listen(3461, "127.0.0.1", () => console.log("Offline UI fixture: http://127.0.0.1:3461"));
