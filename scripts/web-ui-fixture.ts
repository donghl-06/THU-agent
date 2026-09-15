/** Offline UI fixture. No THU clients, scheduler, or real LLM calls. */
import {setTimeout as delay} from "node:timers/promises";
import {createWebServer} from "../src/server/webServer";
import type {Agent} from "../src/harness/agentLoop";
import type {Skill} from "../src/skills/base/types";
process.env.UI_TOKEN = "";
process.env.LLM_VISION = "1";
const fakeWrite: Skill = {name: "book_library_seat", description: "UI 测试预约", inputSchema: {}, requiresConfirmation: true, execute: async () => ({success: true})};
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
        if (question.includes("错误")) throw new Error("Fixture service unavailable");
        if (question.includes("预约")) {
            const approved = await confirm({id: "test_call", type: "function", function: {name: fakeWrite.name, arguments: JSON.stringify({图书馆: "测试图书馆", 座位: "A101", 时间: "14:00–16:00"})}}, fakeWrite);
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
}) as unknown as Agent, {port: 3461, requireLogin: true, titleLlm: {chat: async () => ({role: "assistant", content: "今日课程安排"})}});
server.listen(3461, "127.0.0.1", () => console.log("Offline UI fixture: http://127.0.0.1:3461"));
