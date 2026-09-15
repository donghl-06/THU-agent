/**
 * Skill: get_campus_news_detail —— 查询校园动态/资讯详情。
 *
 * 上游详情有普通 HTML、带附件 HTML 和 PDF 三种形态。PDF 路径可能返回
 * base64 大对象，绝不能原样交给模型；这里统一清洗为纯文本并截断。
 */
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface CampusNewsDetailData {
    title: string;
    abstract: string;
    content: string;
    contentTruncated: boolean;
    kind: "html" | "pdf";
    originalUrl: string;
    note?: string;
}

type NewsDetailSource = {
    getNewsDetail: (url: string) => Promise<[string, string, string]>;
};

const MAX_CONTENT_LENGTH = 8000;
const MAX_ABSTRACT_LENGTH = 500;

const HTML_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
    ldquo: "“",
    rdquo: "”",
    mdash: "—",
    hellip: "…",
};

function decodeHtmlEntities(input: string): string {
    return input.replace(/&([a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);/g, (match, entity: string) => {
        if (entity.startsWith("#")) {
            const codePoint = entity.startsWith("#x") || entity.startsWith("#X")
                ? Number.parseInt(entity.slice(2), 16)
                : Number.parseInt(entity.slice(1), 10);
            return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
                ? String.fromCodePoint(codePoint)
                : match;
        }
        return HTML_ENTITIES[entity] ?? match;
    });
}

function htmlToText(html: string): string {
    return decodeHtmlEntities(
        html
            .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
            .replace(/<[^>]+>/g, ""),
    )
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function truncate(text: string, maxLength: number): {text: string; truncated: boolean} {
    if (text.length <= maxLength) return {text, truncated: false};
    return {text: text.slice(0, maxLength), truncated: true};
}

export function createGetCampusNewsDetailSkill(client: NewsDetailSource): Skill {
    return {
        name: "get_campus_news_detail",
        description:
            "获取一条校园动态/资讯的正文详情。url 必须来自 get_campus_news 返回的 items[].url，" +
            "不能自行编造。普通通知会返回清洗后的正文；PDF 类内容只提示为 PDF，不返回文件数据。",
        inputSchema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "get_campus_news 返回的详情标识，必须原样传入",
                },
            },
            required: ["url"],
        },

        async execute(input: unknown): Promise<SkillResult<CampusNewsDetailData>> {
            const raw = (input ?? {}) as {url?: unknown};
            if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
                return fail("INVALID_INPUT", "url 必须来自 get_campus_news 的返回结果，且不能为空");
            }
            if (raw.url.length > 2048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw.url)) {
                return fail("INVALID_INPUT", "url 格式不合法");
            }
            const url = raw.url.trim();

            try {
                const [rawTitle, rawContent, rawAbstract] = await client.getNewsDetail(url);
                if (rawTitle === "PdF" && rawAbstract === "PdF") {
                    return ok({
                        title: "PDF 附件",
                        abstract: "",
                        content: "",
                        contentTruncated: false,
                        kind: "pdf",
                        originalUrl: url,
                        note: "这条动态的正文是 PDF 附件。当前工具不传输 PDF 内容，请先展示标题和来源，并说明需要到 THU Info 或原链接查看完整附件。",
                    });
                }

                const content = truncate(htmlToText(rawContent), MAX_CONTENT_LENGTH);
                const abstract = truncate(htmlToText(rawAbstract), MAX_ABSTRACT_LENGTH);
                return ok({
                    title: htmlToText(rawTitle) || "未命名动态",
                    abstract: abstract.text,
                    content: content.text,
                    contentTruncated: content.truncated,
                    kind: "html",
                    originalUrl: url,
                });
            } catch (e) {
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
