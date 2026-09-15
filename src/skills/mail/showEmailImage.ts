/**
 * Skill: show_email_image —— 把邮件里的图片附件直接显示在对话里。
 *
 * 场景：课程群二维码、通知截图这类图片附件，用户想在聊天里直接看到，
 * 而不是下载到磁盘自己翻。流程（本地前后一致，不留残余）：
 *   取附件字节 → TempImageStore 落临时文件换 URL → 模型把返回的
 *   markdown 原样写进回复 → 图片旁有「已用完」按钮，用户点击确认后
 *   服务端才删本地文件（15 分钟 TTL 做不点的兜底）。
 * 非图片附件不在这里处理（提示用户用下载场景）；Web UI 之外的环境
 * （CLI/MCP）没有图片端点，报 NOT_SUPPORTED。
 */
import {ThuError} from "../../client/errors";
import type {MailClient} from "../../client/mail/MailClient";
import type {TempImageStore} from "../../utils/tempImageStore";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

/** 单张图片上限（邮件里的二维码/截图通常几百 KB，20MB 足够宽裕） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ShowEmailImageData {
    filename: string;
    contentType: string;
    sizeBytes: number;
    /** 临时图片 URL（用户在图片旁点「已用完」后服务端才删本地文件） */
    imageUrl: string;
    /** 原样写进最终回复即可在对话中显示图片 */
    markdown: string;
    note: string;
}

type AttachmentSource = Pick<MailClient, "getAttachment">;

export function createShowEmailImageSkill(client: AttachmentSource, images?: TempImageStore): Skill {
    return {
        name: "show_email_image",
        description:
            "把邮件中的图片附件（如课程群二维码、通知截图）直接显示在对话里。" +
            "uid 从 get_emails 获得；邮件有多张图片时用 filename 或 index（从 1 数起）指定。" +
            "成功后必须把返回的 markdown 字段原样写进回复，图片才会显示；" +
            "图片是临时文件，用户在图片旁点「已用完」后服务端才删除。非图片附件不要用这个工具。",
        inputSchema: {
            type: "object",
            properties: {
                uid: {
                    type: "number",
                    description: "邮件 uid（从 get_emails 列表结果获得）",
                },
                filename: {
                    type: "string",
                    description: "可选，附件文件名（支持部分匹配）；多张图片时用来指定",
                },
                index: {
                    type: "number",
                    description: "可选，附件序号（从 1 数起，按 get_emails 详情里的附件顺序）",
                },
            },
            required: ["uid"],
        },

        async execute(input: unknown): Promise<SkillResult<ShowEmailImageData>> {
            if (!images) {
                return fail("NOT_SUPPORTED", "当前环境不支持在对话中显示图片（只有 Web UI 提供图片通道）。");
            }
            const raw = (input ?? {}) as Record<string, unknown>;
            const uid = Number(raw.uid);
            if (!Number.isInteger(uid) || uid <= 0) {
                return fail("INVALID_INPUT", "uid 必须是正整数（从 get_emails 列表结果获得）");
            }
            if (raw.filename !== undefined && typeof raw.filename !== "string") {
                return fail("INVALID_INPUT", "filename 必须是字符串");
            }
            if (raw.index !== undefined && (!Number.isInteger(Number(raw.index)) || Number(raw.index) <= 0)) {
                return fail("INVALID_INPUT", "index 必须是从 1 数起的正整数");
            }

            try {
                const att = await client.getAttachment(uid, {
                    filename: raw.filename as string | undefined,
                    index: raw.index === undefined ? undefined : Number(raw.index),
                });
                if (!att) {
                    return fail("NOT_FOUND", `找不到 uid=${uid} 的邮件（可能已被删除或移动）`);
                }
                if (!att.contentType.startsWith("image/")) {
                    return fail(
                        "INVALID_INPUT",
                        `附件「${att.filename}」不是图片（${att.contentType}）。` +
                        "非图片附件请改用下载方式交给用户，不要用本工具。",
                    );
                }
                if (att.content.length > MAX_IMAGE_BYTES) {
                    return fail("INVALID_INPUT", `图片太大（${Math.round(att.content.length / 1024 / 1024)}MB），不在对话里显示。`);
                }
                const {url} = images.put(att.content, att.contentType, att.filename);
                return ok({
                    filename: att.filename,
                    contentType: att.contentType,
                    sizeBytes: att.content.length,
                    imageUrl: url,
                    markdown: `![${att.filename}](${url})`,
                    note: "把 markdown 字段原样写进回复，用户就能在对话里看到图片；图片为临时文件，用户在图片旁点「已用完」后服务端才从本地删除（在此之前刷新历史也能看）。",
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
