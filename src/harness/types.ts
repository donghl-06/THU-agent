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

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
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
