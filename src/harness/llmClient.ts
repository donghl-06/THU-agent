/**
 * LLM 客户端：OpenAI 兼容的 chat.completions 调用（纯 fetch，不引入 SDK）。
 *
 * 任何兼容该协议的提供商都能用（Kimi/GLM/DeepSeek），切换只改 .env。
 * 错误归一化为带 HTTP 状态码的 Error，由上层决定如何展示。
 *
 * 两种模式：
 *   chat       —— 非流式，一次拿完整响应（评测/测试用，行为最可预测）
 *   chatStream —— SSE 流式，onToken 逐 token 回调（交互界面用，
 *                首字延迟从"整段生成时间"降到"网络往返+首 token"）
 */
import {config} from "../config/env";
import "../utils/httpProxy"; // 全局 fetch 走 https_proxy（若设置）
import type {ChatMessage, ChatResponse, ToolSchema} from "./types";

const TIMEOUT_MS = 120_000;
/** 网络层失败（非超时、非 HTTP 错误）时的重试次数——WSL/代理环境下偶发抖动 */
const NETWORK_RETRY = 1;

export interface LlmClient {
    chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<ChatMessage>;
    /**
     * 流式版本：onToken 收到每个内容 token；返回值与非流式一致
     * （tool_calls 在流里是增量碎片，内部拼好后整体返回）。
     * 可选方法——不支持流式的假 LLM 不实现它，Agent 会自动退回 chat。
     */
    chatStream?(messages: ChatMessage[], tools: ToolSchema[], onToken: (token: string) => void): Promise<ChatMessage>;
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
    /** 统一的请求入口（连通性 + 重试 + HTTP 错误归一化） */
    const post = async (messages: ChatMessage[], tools: ToolSchema[], stream: boolean): Promise<Response> => {
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
                        ...(stream ? {stream: true} : {}),
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
        return resp;
    };

    return {
        async chat(messages, tools) {
            const resp = await post(messages, tools, false);
            const data = (await resp.json()) as ChatResponse;
            const message = data.choices?.[0]?.message;
            if (!message) {
                throw new Error("LLM 返回了空响应（没有 choices）。");
            }
            return message;
        },

        async chatStream(messages, tools, onToken) {
            const resp = await post(messages, tools, true);
            if (!resp.body) throw new Error("LLM 流式响应没有 body。");

            // SSE 解析：逐行读 "data: {...}"，content 增量立刻回调，
            // tool_calls 增量按 index 拼成完整调用
            let content = "";
            const toolCalls = new Map<number, {id: string; name: string; arguments: string}>();
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            const handleLine = (line: string) => {
                if (!line.startsWith("data:")) return;
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") return;
                let chunk: {
                    choices?: {
                        delta?: {
                            content?: string;
                            tool_calls?: {index: number; id?: string; function?: {name?: string; arguments?: string}}[];
                        };
                    }[];
                };
                try {
                    chunk = JSON.parse(payload);
                } catch {
                    return; // 忽略不完整/注释行
                }
                const delta = chunk.choices?.[0]?.delta;
                if (!delta) return;
                if (delta.content) {
                    content += delta.content;
                    onToken(delta.content);
                }
                for (const tc of delta.tool_calls ?? []) {
                    const cur = toolCalls.get(tc.index) ?? {id: "", name: "", arguments: ""};
                    if (tc.id) cur.id = tc.id;
                    if (tc.function?.name) cur.name += tc.function.name;
                    if (tc.function?.arguments) cur.arguments += tc.function.arguments;
                    toolCalls.set(tc.index, cur);
                }
            };

            // 按行切分 SSE 流（data: 行可能跨 chunk 边界）
            for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, {stream: true});
                let nl: number;
                while ((nl = buffer.indexOf("\n")) !== -1) {
                    handleLine(buffer.slice(0, nl));
                    buffer = buffer.slice(nl + 1);
                }
            }
            if (buffer.trim()) handleLine(buffer);

            const calls = [...toolCalls.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, c]) => ({
                    id: c.id || `call_${toolCalls.size}_${c.name}`,
                    type: "function" as const,
                    function: {name: c.name, arguments: c.arguments},
                }))
                .filter((c) => c.function.name);
            return {
                role: "assistant",
                content: content || null,
                ...(calls.length > 0 ? {tool_calls: calls} : {}),
            };
        },
    };
}
