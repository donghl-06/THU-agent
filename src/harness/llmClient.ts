/**
 * LLM 客户端：OpenAI 兼容的 chat.completions 调用（纯 fetch，不引入 SDK）。
 *
 * 任何兼容该协议的提供商都能用（Kimi/GLM/DeepSeek），切换只改 .env。
 * 错误归一化为带 HTTP 状态码的 Error，由上层决定如何展示。
 */
import {config} from "../config/env";
import type {ChatMessage, ChatResponse, ToolSchema} from "./types";

const TIMEOUT_MS = 120_000;
/** 网络层失败（非超时、非 HTTP 错误）时的重试次数——WSL/代理环境下偶发抖动 */
const NETWORK_RETRY = 1;

export interface LlmClient {
    chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<ChatMessage>;
}

/** 从 fetch 的 cause 链里挖出真正的底层原因（ECONNRESET/ENOTFOUND/…） */
function networkCause(e: unknown): string {
    let cur: unknown = e;
    const parts: string[] = [];
    while (cur instanceof Error) {
        parts.push(cur.message);
        cur = cur.cause;
    }
    return parts.join(" ← ");
}

export function createLlmClient(): LlmClient {
    return {
        async chat(messages, tools) {
            let resp: Response | undefined;
            for (let attempt = 0; attempt <= NETWORK_RETRY; attempt++) {
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
                    break;
                } catch (e) {
                    if (e instanceof Error && e.name === "TimeoutError") {
                        throw new Error("LLM 请求超时（120s），请稍后重试。");
                    }
                    if (attempt < NETWORK_RETRY) continue; // 网络抖动，重试一次
                    throw new Error(
                        `LLM 网络请求失败：${networkCause(e)}。` +
                        `（注意：Node 的 fetch 不走系统代理，如开了代理/Clash 请确认其"允许局域网连接"且稳定）`,
                    );
                }
            }
            if (!resp) throw new Error("LLM 网络请求失败。");
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
