/**
 * Skill: send_email —— 通过清华邮箱发送邮件（写操作，真实送达）。
 *
 * 安全红线（plan4ai.md）：requiresConfirmation = true，Harness 必须先向用户
 * 展示收件人/主题/正文并拿到明确同意才会执行。邮件发出不可撤回，
 * 模型必须先把正文草稿给用户看过再调用。
 */
import {ThuError} from "../../client/errors";
import type {MailClient} from "../../client/mail/MailClient";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface SendEmailData {
    to: string;
    cc?: string;
    subject: string;
    message: string;
}

type SendSource = Pick<MailClient, "sendMail">;

/** 宽松地址校验：每段都得像 user@domain（逗号分隔多地址） */
function validAddressList(value: string): boolean {
    return value.split(",").every((part) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(part.trim()));
}

export function createSendEmailSkill(client: SendSource): Skill {
    return {
        name: "send_email",
        description:
            "通过用户的清华邮箱（dhl24@mails.tsinghua.edu.cn）发送邮件（写操作，真实送达，不可撤回）。" +
            "调用前必须把收件人/主题/正文草稿展示给用户并得到明确同意。to/cc 支持逗号分隔多个地址。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                to: {
                    type: "string",
                    description: "收件人地址，多个用英文逗号分隔，如“teacher@tsinghua.edu.cn”",
                },
                subject: {
                    type: "string",
                    description: "邮件主题",
                },
                text: {
                    type: "string",
                    description: "邮件正文（纯文本）",
                },
                cc: {
                    type: "string",
                    description: "可选，抄送地址，多个用英文逗号分隔",
                },
            },
            required: ["to", "subject", "text"],
        },

        async execute(input: unknown): Promise<SkillResult<SendEmailData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            for (const k of ["to", "subject", "text"] as const) {
                if (typeof raw[k] !== "string" || !(raw[k] as string).trim()) {
                    return fail("INVALID_INPUT", `${k} 必填且必须是非空字符串`);
                }
            }
            if (raw.cc !== undefined && typeof raw.cc !== "string") {
                return fail("INVALID_INPUT", "cc 必须是字符串");
            }
            const to = (raw.to as string).trim();
            const cc = (raw.cc as string | undefined)?.trim();
            if (!validAddressList(to)) {
                return fail("INVALID_INPUT", `收件人地址格式不对：“${to}”（多个地址用英文逗号分隔）`);
            }
            if (cc && !validAddressList(cc)) {
                return fail("INVALID_INPUT", `抄送地址格式不对：“${cc}”`);
            }

            try {
                await client.sendMail({
                    to,
                    ...(cc ? {cc} : {}),
                    subject: (raw.subject as string).trim(),
                    text: raw.text as string,
                });
                return ok({
                    to,
                    ...(cc ? {cc} : {}),
                    subject: (raw.subject as string).trim(),
                    message: `邮件已发送给 ${to}${cc ? `（抄送 ${cc}）` : ""}。`,
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
