/**
 * 清华邮箱（MailClient）真链验证脚本。
 *
 * 运行：pnpm mail
 * 完成标准：终端能看到收件箱最新邮件摘要和第一封邮件的正文片段。
 * 只读操作：不发信（发信请通过 Agent 走确认流程）。
 */
import {MailClient} from "../src/client/mail/MailClient";
import {config} from "../src/config/env";
import {formatBeijing} from "../src/skills/learn/format";

const mail = new MailClient({
    username: config.email.username,
    password: config.email.password,
    imapHost: config.email.imapHost,
    imapPort: config.email.imapPort,
    smtpHost: config.email.smtpHost,
    smtpPort: config.email.smtpPort,
});

console.log(`正在连接 ${config.email.imapHost}:${config.email.imapPort}……`);
const summaries = await mail.listMessages({limit: 5});
console.log(`登录成功。收件箱最新 ${summaries.length} 封邮件：`);
for (const m of summaries) {
    const from = m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address;
    console.log(`- uid=${m.uid} [${formatBeijing(m.date)}] ${m.subject} ← ${from}${m.seen ? "" : " 【未读】"}`);
}

const first = summaries[0];
if (first) {
    console.log(`\n== 读取 uid=${first.uid} 完整正文 ==`);
    const detail = await mail.getMessage(first.uid);
    if (detail) {
        console.log(`主题：${detail.subject}`);
        console.log(`发件人：${detail.from}`);
        console.log(`收件人：${detail.to}`);
        const body = detail.text.trim();
        console.log(`正文片段：${body ? body.slice(0, 200).replace(/\n+/g, " / ") : "(无纯文本正文)"}`);
        if (detail.attachments.length > 0) {
            console.log(`附件（${detail.attachments.length} 个）：`);
            for (const a of detail.attachments) {
                console.log(`- ${a.filename}（${a.size} 字节）`);
            }
            // 附件取件链路：自动选唯一图片附件，只验证字节数，不落盘
            const att = await mail.getAttachment(first.uid);
            if (att) {
                console.log(`取附件成功：${att.filename}（${att.contentType}，实收 ${att.content.length} 字节）`);
            }
        }
    }
}

console.log("\n邮箱链路验证通过：MailClient → IMAP 收信正常（发信不自动测试，走 Agent 确认流程）。");
