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
import type {ChatMessage, ChatResponse, RawUsage, TokenUsage, ToolSchema} from "./types";

const TIMEOUT_MS = 120_000;
/** 网络层失败（非超时、非 HTTP 错误）时的重试次数——WSL/代理环境下偶发抖动 */
const NETWORK_RETRY = 1;

/** usage 统计回调：拿到一次 LLM 响应的 token 消耗（端点没返回就不回调） */
export type UsageCallback = (usage: TokenUsage) => void;

function normalizeUsage(raw: RawUsage): TokenUsage {
    return {
        promptTokens: Number(raw.prompt_tokens ?? 0),
        completionTokens: Number(raw.completion_tokens ?? 0),
        totalTokens: Number(raw.total_tokens ?? (raw.prompt_tokens ?? 0) + (raw.completion_tokens ?? 0)),
    };
}

export interface LlmClient {
    /** signal：外部中止信号（可选，用户"停止生成"用），与内部超时信号合并 */
    chat(messages: ChatMessage[], tools: ToolSchema[], signal?: AbortSignal, onUsage?: UsageCallback): Promise<ChatMessage>;
    /**
     * 流式版本：onToken 收到每个内容 token；返回值与非流式一致
     * （tool_calls 在流里是增量碎片，内部拼好后整体返回）。
     * 可选方法——不支持流式的假 LLM 不实现它，Agent 会自动退回 chat。
     */
    chatStream?(messages: ChatMessage[], tools: ToolSchema[], onToken: (token: string) => void, signal?: AbortSignal, onUsage?: UsageCallback): Promise<ChatMessage>;
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
    const post = async (messages: ChatMessage[], tools: ToolSchema[], stream: boolean, signal?: AbortSignal): Promise<Response> => {
        let resp: Response | undefined;
        // 外部中止信号与超时信号合并；外部中止不重试
        const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
        const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const send = (withUsageOption: boolean): Promise<Response> => fetch(`${config.llm.baseUrl}/chat/completions`, {
            method: "POST",
            signal: combined,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.llm.apiKey}`,
            },
            body: JSON.stringify({
                model: config.llm.model,
                messages,
                ...(tools.length > 0 ? {tools} : {}),
                ...(stream ? {stream: true} : {}),
                // 流式统计 usage 的 OpenAI 惯例开关；个别网关不认识该字段时去掉重试
                ...(stream && withUsageOption ? {stream_options: {include_usage: true}} : {}),
            }),
        });
        for (let attempt = 0; attempt <= NETWORK_RETRY; attempt++) {
            try {
                resp = await send(true);
                if (!resp.ok && resp.status === 400 && stream) {
                    const errBody = await resp.text();
                    if (errBody.includes("stream_options")) {
                        resp = await send(false); // 端点不支持该字段：去掉重发
                    } else {
                        // 错误体已消费，重建 Response 供下方统一报错
                        resp = new Response(errBody, {status: 400, statusText: resp.statusText});
                    }
                }
                break;
            } catch (e) {
                if (signal?.aborted) throw e; // 用户中止：原样抛出，不归一化不重试
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
        async chat(messages, tools, signal, onUsage) {
            const resp = await post(messages, tools, false, signal);
            const data = (await resp.json()) as ChatResponse & {usage?: RawUsage};
            const message = data.choices?.[0]?.message;
            if (!message) {
                throw new Error("LLM 返回了空响应（没有 choices）。");
            }
            if (data.usage && onUsage) onUsage(normalizeUsage(data.usage));
            return message;
        },

        async chatStream(messages, tools, onToken, signal, onUsage) {
            const resp = await post(messages, tools, true, signal);
            if (!resp.body) throw new Error("LLM 流式响应没有 body。");

            // SSE 解析：逐行读 "data: {...}"，content 增量立刻回调，
            // tool_calls 增量按 index 拼成完整调用
            let content = "";
            const toolCalls = new Map<number, {id: string; name: string; arguments: string}>();
            let usage: RawUsage | undefined; // usage 块通常在流末尾（choices 为空）
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
                    usage?: RawUsage;
                };
                try {
                    chunk = JSON.parse(payload);
                } catch {
                    return; // 忽略不完整/注释行
                }
                if (chunk.usage) usage = chunk.usage;
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
            if (usage && onUsage) onUsage(normalizeUsage(usage));

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
