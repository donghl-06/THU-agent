/**
 * Agent Loop：plan4ai.md 第 11 节的最基础闭环。
 *
 *   用户消息 → 模型 → 要调工具？→ 是 → 执行 Skill → 结果塞回对话 → 模型继续
 *                          ↓ 否
 *                        返回文字回答
 *
 * 明确不做（plan4ai.md 红线）：多 Agent、Planner、长期记忆、RAG、工作流引擎。
 * 会话就是内存里的 messages 数组（Basic Session），进程结束即消失。
 */
import type {Skill} from "../skills/base/types";
import {createLlmClient, type LlmClient} from "./llmClient";
import {ToolRegistry, type ConfirmFn} from "./toolRegistry";
import type {ChatMessage} from "./types";

/** 单轮对话最多允许的工具调用轮数（防模型失控死循环） */
const MAX_TOOL_ROUNDS = 10;

export interface AgentRunResult {
    /** 模型的最终文字回答 */
    answer: string;
    /** 本轮发生的工具调用记录（便于观察模型行为、排查问题） */
    toolCalls: {name: string; input: string; result: string}[];
}

export class Agent {
    private readonly llm: LlmClient;
    private readonly registry: ToolRegistry;
    private readonly messages: ChatMessage[] = [];

    /**
     * @param skills 注册的技能清单
     * @param systemPrompt 系统提示词
     * @param llm 可选注入（测试用假 LLM）
     * @param confirm 写操作的用户确认回调；不写则写操作一律拒绝执行
     */
    constructor(skills: Skill[], systemPrompt: string, llm?: LlmClient, confirm?: ConfirmFn) {
        this.llm = llm ?? createLlmClient();
        this.registry = new ToolRegistry(skills, confirm);
        this.messages.push({role: "system", content: systemPrompt});
    }

    /** 问一个问题，拿到最终回答。多轮对话通过 messages 数组自然延续 */
    async ask(question: string): Promise<AgentRunResult> {
        this.messages.push({role: "user", content: question});
        const toolCalls: AgentRunResult["toolCalls"] = [];

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const message = await this.llm.chat(this.messages, this.registry.schemas());
            this.messages.push(message);

            if (!message.tool_calls?.length) {
                return {answer: message.content ?? "", toolCalls};
            }
            // 模型请求调工具：逐个执行，结果以 tool 消息塞回对话
            for (const call of message.tool_calls) {
                const result = await this.registry.execute(call);
                toolCalls.push({name: call.function.name, input: call.function.arguments, result});
                this.messages.push({role: "tool", tool_call_id: call.id, content: result});
            }
        }
        throw new Error(`工具调用超过 ${MAX_TOOL_ROUNDS} 轮仍未收敛，已中止（疑似模型行为异常）。`);
    }
}
