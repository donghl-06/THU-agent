/**
 * LLM 客户端：OpenAI 兼容的 chat.completions 调用（纯 fetch，不引入 SDK）。
 *
 * 任何兼容该协议的提供商都能用（Kimi/GLM/DeepSeek），切换只改 .env。
 * 错误归一化为带 HTTP 状态码的 Error，由上层决定如何展示。
 */
import {config} from "../config/env";
import type {ChatMessage, ChatResponse, ToolSchema} from "./types";

const TIMEOUT_MS = 120_000;

export interface LlmClient {
    chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<ChatMessage>;
}

export function createLlmClient(): LlmClient {
    return {
        async chat(messages, tools) {
            let resp: Response;
            try {
                resp = await fetch(`${config.llm.baseUrl}/chat/completions`, {
                    method: "POST",
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${config.llm.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: config.llm.model,
                        messages,
                        ...(tools.length > 0 ? {tools} : {}),
                    }),
                });
            } catch (e) {
                if (e instanceof Error && e.name === "TimeoutError") {
                    throw new Error("LLM 请求超时（120s），请稍后重试。");
                }
                throw new Error(`LLM 网络请求失败：${(e as Error).message}`);
            }
            if (!resp.ok) {
                const body = await resp.text();
                if (resp.status === 401) {
                    throw new Error("LLM API Key 无效或过期（HTTP 401），请检查 .env 里的 LLM_API_KEY。");
                }
                if (resp.status === 400 && body.includes("model")) {
                    throw new Error(`模型名可能不对（HTTP 400）：${body.slice(0, 200)}。请核对 .env 里的 LLM_MODEL 与平台控制台一致。`);
                }
                throw new Error(`LLM 接口报错（HTTP ${resp.status}）：${body.slice(0, 300)}`);
            }
            const data = (await resp.json()) as ChatResponse;
            const message = data.choices?.[0]?.message;
            if (!message) {
                throw new Error("LLM 返回了空响应（没有 choices）。");
            }
            return message;
        },
    };
}
