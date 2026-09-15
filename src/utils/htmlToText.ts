/**
 * HTML → 纯文本：网络学堂的通知/作业描述是富文本 HTML，
 * 直接喂给模型既浪费 token 又难看，这里剥成干净文本。
 * （与 learnX 的 removeTags 同款思路：去注释 → 去标签 → 解码实体 → 收敛空白）
 */
import {decodeHTML} from "entities";

/** 块级标签先换成换行，避免段落粘在一起 */
const BLOCK_TAGS = /<\/?(?:p|div|br|li|tr|h[1-6]|table|ul|ol|blockquote)[^>]*>/gi;

export function htmlToText(html?: string | null): string {
    if (!html) return "";
    try {
        const text = decodeHTML(
            html
                .replace(/<!--[\s\S]*?-->/g, "")
                .replace(/<script[\s\S]*?<\/script>/gi, "")
                .replace(/<style[\s\S]*?<\/style>/gi, "")
                .replace(BLOCK_TAGS, "\n")
                .replace(/<(?:.|\n)*?>/gm, ""),
        );
        return text
            .replace(/[ \t ]+/g, " ")
            .replace(/\n\s+/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return "";
    }
}
