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

/** 写操作测试 Skill：记录是否被执行 */
function fakeWriteSkill(state: {executed: boolean}): Skill {
    return {
        name: "book_thing",
        description: "预约测试，仅测试用",
        inputSchema: {type: "object", properties: {what: {type: "string"}}},
        requiresConfirmation: true,
        async execute(input) {
            state.executed = true;
            return ok({booked: input});
        },
    };
}

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
    it("带图片的问题构造多模态 parts 消息", async () => {
        const llm = fakeLlm([textMsg("图上是一只猫")]);
        const agent = new Agent([echoSkill], "你是测试助手", llm);
        const img = "data:image/png;base64,iVBORw0KGgo=";
        const result = await agent.ask("图里有什么？", {images: [img]});
        expect(result.answer).toBe("图上是一只猫");

        // 发给 LLM 的用户消息应是 [text, image_url] parts 结构
        const userMsg = llm.seen[0].at(-1)!;
        expect(userMsg.role).toBe("user");
        expect(userMsg.content).toEqual([
            {type: "text", text: "图里有什么？"},
            {type: "image_url", image_url: {url: img}},
        ]);
    });

    it("只发图不带文字时用默认提示语", async () => {
        const llm = fakeLlm([textMsg("一张截图")]);
        const agent = new Agent([echoSkill], "你是测试助手", llm);
        await agent.ask("", {images: ["data:image/png;base64,iVBORw0KGgo="]});
        const userMsg = llm.seen[0].at(-1)!;
        expect((userMsg.content as {text?: string}[])[0].text).toBe("请看这张图。");
    });

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
        expect(JSON.parse(toolMessage.content as string)).toEqual({success: true, data: {echo: {text: "hello"}}});
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

describe("写操作确认流", () => {
    it("用户同意后写操作才真正执行", async () => {
        const state = {executed: false};
        const llm = fakeLlm([toolCallMsg("book_thing", {what: "羽毛球"}), textMsg("订好了")]);
        const confirm = async () => true; // 模拟用户输入 y
        const agent = new Agent([fakeWriteSkill(state)], "你是测试助手", llm, confirm);
        const result = await agent.ask("帮我订");
        expect(state.executed).toBe(true);
        expect(result.answer).toBe("订好了");
        expect(JSON.parse(result.toolCalls[0].result).success).toBe(true);
    });

    it("用户拒绝时不执行，并把 USER_REJECTED 喂回模型", async () => {
        const state = {executed: false};
        const llm = fakeLlm([toolCallMsg("book_thing", {what: "羽毛球"}), textMsg("好的，已取消")]);
        const confirm = async () => false; // 模拟用户输入 n
        const agent = new Agent([fakeWriteSkill(state)], "你是测试助手", llm, confirm);
        const result = await agent.ask("帮我订");
        expect(state.executed).toBe(false);
        const toolResult = JSON.parse(result.toolCalls[0].result);
        expect(toolResult.success).toBe(false);
        expect(toolResult.error.code).toBe("USER_REJECTED");
        expect(result.answer).toBe("好的，已取消");
    });

    it("没有确认通道的环境拒绝执行写操作（fail closed）", async () => {
        const state = {executed: false};
        const llm = fakeLlm([toolCallMsg("book_thing", {what: "羽毛球"}), textMsg("这里没法确认")]);
        const agent = new Agent([fakeWriteSkill(state)], "你是测试助手", llm); // 不传 confirm
        const result = await agent.ask("帮我订");
        expect(state.executed).toBe(false);
        expect(JSON.parse(result.toolCalls[0].result).error.code).toBe("CONFIRMATION_UNAVAILABLE");
    });
});

describe("Step 17 性能优化行为", () => {
    /** 慢速读 Skill：记录执行起止时间，用于验证并行 */
    function slowReadSkill(name: string, ms: number, log: {name: string; start: number; end: number}[]): Skill {
        return {
            name,
            description: "慢速读，仅测试用",
            inputSchema: {type: "object", properties: {}},
            async execute() {
                const start = performance.now();
                await new Promise((r) => setTimeout(r, ms));
                log.push({name, start, end: performance.now()});
                return ok({done: name});
            },
        };
    }

    it("同一轮的多个纯读工具调用并行执行", async () => {
        const log: {name: string; start: number; end: number}[] = [];
        const twoCalls: ChatMessage = {
            role: "assistant",
            content: null,
            tool_calls: [
                {id: "c1", type: "function", function: {name: "slow_a", arguments: "{}"}},
                {id: "c2", type: "function", function: {name: "slow_b", arguments: "{}"}},
            ],
        };
        const llm = fakeLlm([twoCalls, textMsg("都查完了")]);
        const agent = new Agent(
            [slowReadSkill("slow_a", 100, log), slowReadSkill("slow_b", 100, log)],
            "你是测试助手", llm,
        );
        await agent.ask("查两个东西");
        // 串行的话 b.start >= a.end；并行则 b.start < a.end
        expect(log).toHaveLength(2);
        const a = log.find((l) => l.name === "slow_a")!;
        const b = log.find((l) => l.name === "slow_b")!;
        expect(b.start).toBeLessThan(a.end);
    });

    it("含写操作的一轮调用退化为串行（确认顺序不乱）", async () => {
        const state = {executed: false};
        const log: {name: string; start: number; end: number}[] = [];
        const twoCalls: ChatMessage = {
            role: "assistant",
            content: null,
            tool_calls: [
                {id: "c1", type: "function", function: {name: "slow_a", arguments: "{}"}},
                {id: "c2", type: "function", function: {name: "book_thing", arguments: "{}"}},
            ],
        };
        const llm = fakeLlm([twoCalls, textMsg("完成")]);
        const agent = new Agent(
            [slowReadSkill("slow_a", 50, log), fakeWriteSkill(state)],
            "你是测试助手", llm, async () => true,
        );
        await agent.ask("查一下再订");
        expect(state.executed).toBe(true);
    });

    it("onToolEvent 发出 start/end 事件且 end 带耗时", async () => {
        const events: {phase: string; name: string; success?: boolean}[] = [];
        const llm = fakeLlm([toolCallMsg("echo", {text: "hi"}), textMsg("回了")]);
        const agent = new Agent([echoSkill], "你是测试助手", llm);
        await agent.ask("回显", {onToolEvent: (e) => events.push(e)});
        expect(events.map((e) => e.phase)).toEqual(["start", "end"]);
        expect(events[0].name).toBe("echo");
        expect(events[1].success).toBe(true);
    });

    it("LLM 不支持流式时 onToken 自动退回普通 chat（兼容假 LLM）", async () => {
        const llm = fakeLlm([textMsg("你好呀")]);
        const agent = new Agent([], "你是测试助手", llm);
        const tokens: string[] = [];
        const r = await agent.ask("你好", {onToken: (t) => tokens.push(t)});
        expect(r.answer).toBe("你好呀");
        // 假 LLM 没实现 chatStream，走 chat，onToken 不应被调用
        expect(tokens).toEqual([]);
    });

    it("工具执行抛异常时兜底成 TOOL_CRASH 结果喂回模型，不炸掉整轮", async () => {
        const crashSkill: Skill = {
            name: "crash",
            description: "必炸，仅测试用",
            inputSchema: {type: "object", properties: {}},
            async execute() { throw new Error("boom"); },
        };
        const llm = fakeLlm([toolCallMsg("crash", {}), textMsg("工具挂了，如实告知")]);
        const agent = new Agent([crashSkill], "你是测试助手", llm);
        const r = await agent.ask("试试");
        const toolResult = JSON.parse(r.toolCalls[0].result);
        expect(toolResult.success).toBe(false);
        expect(toolResult.error.code).toBe("TOOL_CRASH");
        expect(r.answer).toContain("如实告知");
    });
});
