/**
 * 会话标题生成单测：第一轮提取、LLM 输出清洗、失败兜底。
 */
import {describe, expect, it} from "vitest";
import type {LlmClient} from "../../src/harness/llmClient";
import type {ChatMessage} from "../../src/harness/types";
import {firstRoundTexts, generateTitle} from "../../src/server/titleGen";

const textMsg = (text: string): ChatMessage => ({role: "assistant", content: text});
const toolCallMsg = (name: string, id = "c1"): ChatMessage => ({
    role: "assistant",
    content: null,
    tool_calls: [{id, type: "function", function: {name, arguments: "{}"}}],
});

function llmReturning(content: string): LlmClient {
    return {async chat() { return {role: "assistant", content}; }};
}

describe("firstRoundTexts", () => {
    it("取第一轮的 user 提问与 assistant 文本回答（跳过中间工具轮）", () => {
        const round = firstRoundTexts([
            {role: "system", content: "sys"},
            {role: "user", content: "你好"},
            toolCallMsg("get_schedule"),
            {role: "tool", content: "{}"},
            textMsg("你好！有什么可以帮你？"),
            {role: "user", content: "第二个问题"},
        ]);
        expect(round).toEqual({user: "你好", assistant: "你好！有什么可以帮你？"});
    });

    it("多模态 user 消息提取文本部分", () => {
        const round = firstRoundTexts([
            {role: "user", content: [{type: "text", text: "看这张图"}, {type: "image_url", image_url: {url: "data:..."}}]},
            textMsg("是一只猫"),
        ]);
        expect(round?.user).toBe("看这张图");
    });

    it("没有 assistant 文本回答 → undefined", () => {
        expect(firstRoundTexts([{role: "user", content: "hi"}])).toBeUndefined();
    });
});

describe("generateTitle", () => {
    it("返回 LLM 标题并清理引号句号", async () => {
        const title = await generateTitle(llmReturning("“打招呼”。"), [
            {role: "user", content: "你好"},
            textMsg("你好呀！"),
        ]);
        expect(title).toBe("打招呼");
    });

    it("LLM 输出多行时只取第一行", async () => {
        const title = await generateTitle(llmReturning("订羽毛球场\n解释：用户想订场"), [
            {role: "user", content: "今晚有羽毛球场吗"},
            textMsg("有。"),
        ]);
        expect(title).toBe("订羽毛球场");
    });

    it("LLM 失败返回 undefined", async () => {
        const failing: LlmClient = {async chat() { throw new Error("网络挂了"); }};
        const title = await generateTitle(failing, [{role: "user", content: "你好"}, textMsg("你好")]);
        expect(title).toBeUndefined();
    });

    it("对话缺首轮问答 → 不调 LLM 直接 undefined", async () => {
        let called = false;
        const spy: LlmClient = {async chat() { called = true; return textMsg("x"); }};
        const title = await generateTitle(spy, [{role: "system", content: "sys"}]);
        expect(title).toBeUndefined();
        expect(called).toBe(false);
    });
});
