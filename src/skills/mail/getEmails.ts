/**
 * Skill: get_emails —— 读取清华邮箱邮件。
 *
 * 两种模式：
 *   列表模式（默认）：最新邮件摘要（uid/主题/发件人/时间/已读），支持未读过滤、
 *                    主题或发件人关键词过滤
 *   详情模式：给 uid 读该邮件的完整正文与附件清单（uid 从列表模式拿）
 */
import {ThuError} from "../../client/errors";
import type {MailClient} from "../../client/mail/MailClient";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {formatBeijing} from "../learn/format";

/** 正文给模型的长度上限（邮件可能很长，截断保上下文） */
const MAX_BODY_CHARS = 4000;

export interface GetEmailsData {
    mode: "list" | "detail";
    count?: number;
    emails?: {
        uid: number;
        subject: string;
        from: string;
        date: string;
        seen: boolean;
    }[];
    detail?: {
        uid: number;
        subject: string;
        from: string;
        to: string;
        date: string;
        body: string;
        bodyTruncated: boolean;
        attachments: {filename: string; size: number}[];
    };
}

type MailSource = Pick<MailClient, "listMessages" | "getMessage">;

export function createGetEmailsSkill(client: MailSource): Skill {
    return {
        name: "get_emails",
        description:
            "读取清华邮箱（mails.tsinghua.edu.cn）邮件。默认返回收件箱最新邮件列表" +
            "（主题/发件人/时间/已读状态）；unreadOnly=true 只看未读；keyword 按主题或发件人过滤；" +
            "给 uid 则返回该邮件的完整正文和附件清单（uid 先从列表获取）。",
        inputSchema: {
            type: "object",
            properties: {
                limit: {
                    type: "number",
                    description: "可选，列表模式最多返回多少封，默认 10，最大 50",
                },
                unreadOnly: {
                    type: "boolean",
                    description: "可选，true 时只返回未读邮件，默认 false",
                },
                keyword: {
                    type: "string",
                    description: "可选，按主题/发件人关键词过滤，如“教务”",
                },
                uid: {
                    type: "number",
                    description: "可选，读取指定邮件的完整正文（uid 从列表结果获得）",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<GetEmailsData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            for (const k of ["unreadOnly"] as const) {
                if (raw[k] !== undefined && typeof raw[k] !== "boolean") {
                    return fail("INVALID_INPUT", `${k} 必须是布尔值`);
                }
            }
            if (raw.keyword !== undefined && typeof raw.keyword !== "string") {
                return fail("INVALID_INPUT", "keyword 必须是字符串");
            }
            const limit = raw.limit === undefined ? 10 : Number(raw.limit);
            if (!Number.isInteger(limit) || limit <= 0 || limit > 50) {
                return fail("INVALID_INPUT", "limit 必须是 1-50 的整数");
            }

            try {
                // 详情模式
                if (raw.uid !== undefined) {
                    const uid = Number(raw.uid);
                    if (!Number.isInteger(uid) || uid <= 0) {
                        return fail("INVALID_INPUT", "uid 必须是正整数（从列表结果获得）");
                    }
                    const detail = await client.getMessage(uid);
                    if (!detail) {
                        return fail("NOT_FOUND", `找不到 uid=${uid} 的邮件（可能已被删除或移动）`);
                    }
                    const body = detail.text || "(此邮件没有纯文本正文，可能是纯 HTML 邮件)";
                    return ok({
                        mode: "detail",
                        detail: {
                            uid,
                            subject: detail.subject,
                            from: detail.from,
                            to: detail.to,
                            date: formatBeijing(detail.date),
                            body: body.slice(0, MAX_BODY_CHARS),
                            bodyTruncated: body.length > MAX_BODY_CHARS,
                            attachments: detail.attachments,
                        },
                    });
                }

                // 列表模式
                const emails = await client.listMessages({
                    limit,
                    unreadOnly: raw.unreadOnly as boolean | undefined,
                    keyword: raw.keyword as string | undefined,
                });
                if (emails.length === 0) {
                    return fail(
                        "NOT_FOUND",
                        raw.unreadOnly
                            ? "没有未读邮件"
                            : raw.keyword
                                ? `找不到主题或发件人含“${raw.keyword}”的邮件`
                                : "收件箱是空的",
                    );
                }
                return ok({
                    mode: "list",
                    count: emails.length,
                    emails: emails.map((m) => ({
                        uid: m.uid,
                        subject: m.subject,
                        from: m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address,
                        date: formatBeijing(m.date),
                        seen: m.seen,
                    })),
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
