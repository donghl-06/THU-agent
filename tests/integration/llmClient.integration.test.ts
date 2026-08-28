/**
 * LLM 集成测试：用真实 API（.env 里的 LLM_*）验证两件事：
 *   1. 普通对话能通（模型名/key 正确）；
 *   2. 模型真的支持 Function Calling（这是 Harness 的前提）。
 * 跑之前确保 .env 已填好 LLM_API_KEY。
 */
import {describe, expect, it} from "vitest";
import {createLlmClient} from "../../src/harness/llmClient";
import type {ToolSchema} from "../../src/harness/types";

describe("LLM 真实链路集成测试", () => {
    it("普通对话返回非空回答", async () => {
        const llm = createLlmClient();
        const msg = await llm.chat(
            [{role: "user", content: "只回复四个字：测试通过"}],
            [],
        );
        expect(msg.content).toBeTruthy();
        console.log("模型回复：", msg.content);
    }, 130_000);

    it("模型会主动发起 Function Calling", async () => {
        const llm = createLlmClient();
        const tools: ToolSchema[] = [
            {
                type: "function",
                function: {
                    name: "get_current_time",
                    description: "获取当前服务器时间。用户问现在几点时必须调用。",
                    parameters: {type: "object", properties: {}},
                },
            },
        ];
        const msg = await llm.chat([{role: "user", content: "现在几点了？"}], tools);
        expect(msg.tool_calls?.length).toBeGreaterThan(0);
        expect(msg.tool_calls![0].function.name).toBe("get_current_time");
    }, 130_000);
});
