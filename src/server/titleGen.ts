/**
 * 会话标题生成（用户反馈：主题要概括主题而非截取原文，如"你好"→"打招呼"）。
 *
 * 首轮回答完成后前端调 /api/session/title 触发一次轻量 LLM 调用；
 * 生成失败返回 undefined，前端保持原有的"首条消息截取"标题兜底。
 */
import type {LlmClient} from "../harness/llmClient";
import type {ChatMessage, ContentPart} from "../harness/types";

function textOf(content: ChatMessage["content"]): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((p): p is Extract<ContentPart, {type: "text"}> => p.type === "text")
            .map((p) => p.text)
            .join("\n");
    }
    return "";
}

/** 提取第一轮的 user 提问与 assistant 回答（缺任一则 undefined） */
export function firstRoundTexts(messages: ChatMessage[]): {user: string; assistant: string} | undefined {
    let user: string | undefined;
    for (const m of messages) {
        if (m.role === "user" && user === undefined) {
            const t = textOf(m.content).trim();
            if (t) user = t;
        }
        if (m.role === "assistant") {
            const t = textOf(m.content).trim();
            if (t && user !== undefined) return {user, assistant: t};
        }
    }
    return undefined;
}

/** 生成不超过 8 字的概括式标题；任何失败返回 undefined */
export async function generateTitle(llm: LlmClient, messages: ChatMessage[]): Promise<string | undefined> {
    const round = firstRoundTexts(messages);
    if (!round) return undefined;
    try {
        const message = await llm.chat(
            [
                {
                    role: "system",
                    content: "你是标题生成器。根据这段对话的开头生成不超过8个字的中文对话标题，概括主题而非复述原文" +
                        "（例如用户问好则标题类似\"打招呼\"，问羽毛球场地则类似\"订羽毛球场\"）。" +
                        "只输出标题本身，不要引号、句号或任何说明文字。",
                },
                {role: "user", content: `用户：${round.user.slice(0, 200)}\n助手：${round.assistant.slice(0, 300)}`},
            ],
            [],
        );
        const title = (typeof message.content === "string" ? message.content : "")
            .trim()
            .replace(/^["'“”「『]+|["'“”」』.。]+$/g, "")
            .split("\n")[0]
            .trim()
            .slice(0, 16);
        return title || undefined;
    } catch {
        return undefined;
    }
}
