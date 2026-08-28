/**
 * Harness 单元测试：用脚本化的假 LLM 驱动 Agent Loop，
 * 不碰网络、不碰真实模型，验证闭环、工具分发、错误路径。
 */
import {describe, expect, it} from "vitest";
import {Agent} from "../../src/harness/agentLoop";
import type {LlmClient} from "../../src/harness/llmClient";
import {ToolRegistry} from "../../src/harness/toolRegistry";
import type {ChatMessage} from "../../src/harness/types";
import {ok, type Skill} from "../../src/skills/base/types";

/** 一个固定行为的测试 Skill：回显收到的输入 */
const echoSkill: Skill = {
    name: "echo",
    description: "回显输入，仅测试用",
    inputSchema: {type: "object", properties: {text: {type: "string"}}},
    async execute(input) {
        return ok({echo: input});
    },
};

/** 脚本化假 LLM：按队列依次返回预设的 message，记下发来的 messages */
function fakeLlm(script: ChatMessage[]): LlmClient & {seen: ChatMessage[][]} {
    const seen: ChatMessage[][] = [];
    let i = 0;
    return {
        seen,
        async chat(messages) {
            seen.push([...messages]);
            const next = script[i++];
            if (!next) throw new Error("假 LLM 脚本已耗尽，测试多调了一轮");
            return next;
        },
    };
}

function toolCallMsg(name: string, args: unknown, id = "call_1"): ChatMessage {
    return {
        role: "assistant",
        content: null,
        tool_calls: [{id, type: "function", function: {name, arguments: JSON.stringify(args)}}],
    };
}

const textMsg = (text: string): ChatMessage => ({role: "assistant", content: text});

describe("ToolRegistry", () => {
    it("拒绝重复的 Skill 名", () => {
        expect(() => new ToolRegistry([echoSkill, echoSkill])).toThrow(/重复/);
    });

    it("schemas 把 Skill 转成 OpenAI tools 格式", () => {
        const schemas = new ToolRegistry([echoSkill]).schemas();
        expect(schemas).toEqual([
            {
                type: "function",
                function: {name: "echo", description: echoSkill.description, parameters: echoSkill.inputSchema},
            },
        ]);
    });

    it("未知工具返回 UNKNOWN_TOOL 而不是抛异常（错误要喂回给模型）", async () => {
        const registry = new ToolRegistry([echoSkill]);
        const raw = await registry.execute(toolCallMsg("nonexistent", {}).tool_calls![0]);
        const result = JSON.parse(raw);
        expect(result.success).toBe(false);
        expect(result.error.code).toBe("UNKNOWN_TOOL");
    });

    it("非法 JSON 参数返回 BAD_ARGUMENTS", async () => {
        const registry = new ToolRegistry([echoSkill]);
        const raw = await registry.execute({
            id: "c",
            type: "function",
            function: {name: "echo", arguments: "{not json"},
        });
        const result = JSON.parse(raw);
        expect(result.success).toBe(false);
        expect(result.error.code).toBe("BAD_ARGUMENTS");
    });
});

describe("Agent Loop", () => {
    it("模型直接回答时不调工具，一轮结束", async () => {
        const llm = fakeLlm([textMsg("你好！")]);
        const agent = new Agent([echoSkill], "你是测试助手", llm);
        const result = await agent.ask("打个招呼");
        expect(result.answer).toBe("你好！");
        expect(result.toolCalls).toHaveLength(0);
    });

    it("模型要求调工具 → 执行 → 结果塞回对话 → 模型给最终回答", async () => {
        const llm = fakeLlm([toolCallMsg("echo", {text: "hello"}), textMsg("echo 返回了 hello")]);
        const agent = new Agent([echoSkill], "你是测试助手", llm);
        const result = await agent.ask("帮我 echo 一下");

        expect(result.answer).toBe("echo 返回了 hello");
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].name).toBe("echo");

        // 第二轮调用时，对话里应已有：system / user / assistant(tool_calls) / tool(结果)
        const secondCall = llm.seen[1];
        expect(secondCall.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
        const toolMessage = secondCall[3];
        expect(toolMessage.tool_call_id).toBe("call_1");
        expect(JSON.parse(toolMessage.content!)).toEqual({success: true, data: {echo: {text: "hello"}}});
    });

    it("支持连续多轮工具调用", async () => {
        const llm = fakeLlm([
            toolCallMsg("echo", {text: "第一次"}, "call_a"),
            toolCallMsg("echo", {text: "第二次"}, "call_b"),
            textMsg("两次都完成了"),
        ]);
        const agent = new Agent([echoSkill], "你是测试助手", llm);
        const result = await agent.ask("echo 两次");
        expect(result.answer).toBe("两次都完成了");
        expect(result.toolCalls.map((t) => t.name)).toEqual(["echo", "echo"]);
    });

    it("工具错误也作为结果塞回对话，让模型自己处理", async () => {
        const llm = fakeLlm([toolCallMsg("nonexistent_tool", {}), textMsg("工具不存在，我换个办法")]);
        const agent = new Agent([echoSkill], "你是测试助手", llm);
        const result = await agent.ask("调一个不存在的工具");
        expect(result.answer).toContain("换个办法");
        expect(JSON.parse(result.toolCalls[0].result).error.code).toBe("UNKNOWN_TOOL");
    });

    it("工具调用超过最大轮数时抛错中止（防模型失控）", async () => {
        const endless = Array.from({length: 20}, (_, i) => toolCallMsg("echo", {n: i}, `call_${i}`));
        const llm = fakeLlm(endless);
        const agent = new Agent([echoSkill], "你是测试助手", llm);
        await expect(agent.ask("无限调用")).rejects.toThrow(/轮/);
    });

    it("多轮对话历史在两次 ask 之间保留", async () => {
        const llm = fakeLlm([textMsg("记住啦"), textMsg("你刚才说的是：苹果")]);
        const agent = new Agent([], "你是测试助手", llm);
        await agent.ask("我喜欢苹果");
        await agent.ask("我刚才说什么了？");
        // 第二次调用应带着完整历史
        expect(llm.seen[1].map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    });
});
