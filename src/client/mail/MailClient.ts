/**
 * MailClient —— Agent 项目与清华邮箱（Coremail IMAP/SMTP）之间的适配层。
 *
 * 清华邮箱开放标准邮件协议（2026-09-13 实测）：
 *   收信 imap.tsinghua.edu.cn:993 (IMAP4rev1, imapflow)
 *   发信 smtp.tsinghua.edu.cn:465 (SSL, nodemailer)
 * 登录凭证是网页版邮箱「设置 → 客户端授权码」生成的授权码，不是邮箱密码。
 *
 * 职责：连接生命周期、 envelope/正文解析、错误归一化。
 * 非职责：过滤/裁剪/确认 —— Skill 层的事。
 */
import {ImapFlow, type MessageEnvelopeObject} from "imapflow";
import nodemailer, {type Transporter} from "nodemailer";
import {simpleParser} from "mailparser";
import {ThuError} from "../errors";

export interface MailConfig {
    username?: string;
    /** 客户端授权码 */
    password?: string;
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
}

export interface MailSummary {
    uid: number;
    subject: string;
    from: {name: string; address: string};
    date: Date;
    seen: boolean;
}

export interface MailDetail {
    subject: string;
    from: string;
    to: string;
    date: Date;
    /** 纯文本正文（HTML 邮件取 text 版，没有则由 Skill 层决定如何降级） */
    text: string;
    html?: string;
    attachments: {filename: string; size: number}[];
}

/** 把底层异常归一化为 ThuError（只认邮件场景的常见形态） */
function normalizeMailError(e: unknown): ThuError {
    if (e instanceof ThuError) return e;
    const err = e as {code?: string; responseCode?: number; message?: string; authenticationFailed?: boolean};
    const msg = err?.message ?? String(e);
    // imapflow/nodemailer 认证失败
    if (err?.authenticationFailed || /auth|login|password|535/i.test(msg)) {
        return new ThuError(
            "AUTH_FAILED",
            "邮箱登录失败：客户端授权码无效或已吊销。请到网页版邮箱「设置 → 客户端授权码」重新生成，并更新 .env 的 THU_EMAIL_PASSWORD。",
            e,
        );
    }
    if (err?.code === "ETIMEDOUT" || err?.code === "ESOCKET" || /timeout/i.test(msg)) {
        return new ThuError("TIMEOUT", "连接邮件服务器超时，稍后重试通常有效。", e);
    }
    if (err?.code === "ECONNREFUSED" || err?.code === "ENOTFOUND" || err?.code === "ECONNRESET" || err?.code === "EAI_AGAIN") {
        return new ThuError("NETWORK_ERROR", `连接邮件服务器失败（${err.code}），请检查网络后重试。`, e);
    }
    // SMTP 拒收（收件人不存在/被反垃圾拦截等）
    if (err?.responseCode && err.responseCode >= 500) {
        return new ThuError("UPSTREAM_ERROR", `邮件服务器拒绝：${msg}`, e);
    }
    return new ThuError("UNKNOWN", msg, e);
}

function addressOf(env: MessageEnvelopeObject): {name: string; address: string} {
    const first = env.from?.[0];
    return {name: first?.name ?? "", address: first?.address ?? ""};
}

export class MailClient {
    constructor(private readonly cfg: MailConfig) {}

    private assertConfigured(): void {
        if (!this.cfg.username || !this.cfg.password) {
            throw new ThuError(
                "AUTH_FAILED",
                "未配置邮箱凭证：请在 .env 填 THU_EMAIL_USERNAME（邮箱地址）和 THU_EMAIL_PASSWORD（客户端授权码）。",
            );
        }
    }

    private newImap(): ImapFlow {
        this.assertConfigured();
        return new ImapFlow({
            host: this.cfg.imapHost,
            port: this.cfg.imapPort,
            secure: true,
            auth: {user: this.cfg.username!, pass: this.cfg.password!},
            logger: false,
            socketTimeout: 30_000,
        });
    }

    /**
     * 拉取邮箱摘要列表（按时间倒序，最新在前）。
     * unreadOnly 用服务端 SEARCH；keyword（主题/发件人包含）在本地过滤，
     * 避开 IMAP SEARCH 的 charset 兼容问题。
     */
    async listMessages(opts: {
        mailbox?: string;
        limit?: number;
        unreadOnly?: boolean;
        keyword?: string;
    } = {}): Promise<MailSummary[]> {
        const mailbox = opts.mailbox ?? "INBOX";
        const limit = opts.limit ?? 10;
        const client = this.newImap();
        try {
            await client.connect();
            const lock = await client.getMailboxLock(mailbox);
            try {
                let uids: number[] | undefined;
                if (opts.unreadOnly) {
                    const found = await client.search({seen: false}, {uid: true});
                    uids = found || [];
                }
                // 有候选集时在候选里取最新 limit 个；否则取邮箱最新 limit 个
                const range = uids && uids.length > 0 ? uids.slice(-limit) : "1:*";
                const messages: MailSummary[] = [];
                for await (const msg of client.fetch(range, {envelope: true, flags: true, uid: true}, {uid: true})) {
                    const env = msg.envelope;
                    if (!env) continue;
                    messages.push({
                        uid: msg.uid,
                        subject: env.subject ?? "(无主题)",
                        from: addressOf(env),
                        date: env.date ? new Date(env.date) : new Date(0),
                        seen: msg.flags?.has("\\Seen") ?? false,
                    });
                }
                let result = messages
                    .filter((m) => !uids || uids.includes(m.uid))
                    .sort((a, b) => b.date.getTime() - a.date.getTime());
                const kw = opts.keyword?.trim().toLowerCase();
                if (kw) {
                    result = result.filter((m) =>
                        m.subject.toLowerCase().includes(kw) ||
                        m.from.address.toLowerCase().includes(kw) ||
                        m.from.name.toLowerCase().includes(kw),
                    );
                }
                return result.slice(0, limit);
            } finally {
                lock.release();
            }
        } catch (e) {
            throw normalizeMailError(e);
        } finally {
            await client.logout().catch(() => {});
        }
    }

    /** 按 UID 读取完整邮件（正文 + 附件清单）。不存在返回 undefined */
    async getMessage(uid: number, mailbox = "INBOX"): Promise<MailDetail | undefined> {
        const client = this.newImap();
        try {
            await client.connect();
            const lock = await client.getMailboxLock(mailbox);
            try {
                const msg = await client.fetchOne(String(uid), {source: true}, {uid: true});
                if (!msg || !msg.source) return undefined;
                const parsed = await simpleParser(msg.source);
                const formatAddr = (v: typeof parsed.from) =>
                    v?.value.map((a: {name?: string; address?: string}) =>
                        a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? ""),
                    ).join(", ") ?? "";
                // 顺手标记已读（read-write 模式下 fetch source 默认会置 \Seen，Coremail 行为一致）
                return {
                    subject: parsed.subject ?? "(无主题)",
                    from: formatAddr(parsed.from),
                    to: parsed.to ? formatAddr(parsed.to as typeof parsed.from) : "",
                    date: parsed.date ?? new Date(0),
                    text: parsed.text ?? "",
                    html: typeof parsed.html === "string" ? parsed.html : undefined,
                    attachments: parsed.attachments.map((a: {filename?: string; size: number}) => ({
                        filename: a.filename ?? "(未命名附件)",
                        size: a.size,
                    })),
                };
            } finally {
                lock.release();
            }
        } catch (e) {
            throw normalizeMailError(e);
        } finally {
            await client.logout().catch(() => {});
        }
    }

    /** 发送纯文本邮件。to/cc 为逗号分隔的地址串 */
    async sendMail(opts: {to: string; cc?: string; subject: string; text: string}): Promise<void> {
        this.assertConfigured();
        const transporter: Transporter = nodemailer.createTransport({
            host: this.cfg.smtpHost,
            port: this.cfg.smtpPort,
            secure: true,
            auth: {user: this.cfg.username!, pass: this.cfg.password!},
            connectionTimeout: 20_000,
        });
        try {
            await transporter.sendMail({
                from: this.cfg.username!,
                to: opts.to,
                ...(opts.cc ? {cc: opts.cc} : {}),
                subject: opts.subject,
                text: opts.text,
            });
        } catch (e) {
            throw normalizeMailError(e);
        } finally {
            transporter.close();
        }
    }
}
