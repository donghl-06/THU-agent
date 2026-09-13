/**
 * Harness 消息类型（OpenAI 兼容协议，Kimi/GLM/DeepSeek 通用）。
 * 只定义我们用到的子集。
 */

/** 模型发起的工具调用请求 */
export interface ToolCall {
    id: string;
    type: "function";
    function: {name: string; arguments: string};
}

/**
 * 多模态内容块（OpenAI 兼容）。用户消息可携带图片（data URL）；
 * 仅用户消息用得上，assistant/tool 消息始终用纯字符串。
 */
export type ContentPart =
    | {type: "text"; text: string}
    | {type: "image_url"; image_url: {url: string}};

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | ContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

/** 发给模型的工具描述（由 Skill 的 name/description/inputSchema 转换而来） */
export interface ToolSchema {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: unknown;
    };
}

/** chat.completions 响应中我们关心的部分 */
export interface ChatResponse {
    choices: {message: ChatMessage}[];
}

/** token 用量（OpenAI usage 字段子集，流式需 stream_options.include_usage 才返回） */
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

/** 线上的 usage 字段（snake_case） */
export interface RawUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}
