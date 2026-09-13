/**
 * get_emails / send_email Skill 测试（假 client，无网络）。
 */
import {describe, expect, it} from "vitest";
import {createGetEmailsSkill, type GetEmailsData} from "../../src/skills/mail/getEmails";
import {createSendEmailSkill, type SendEmailData} from "../../src/skills/mail/sendEmail";

const fakeSummaries = [
    {uid: 101, subject: "教务处选课通知", from: {name: "教务处", address: "jwc@tsinghua.edu.cn"}, date: new Date("2026-09-12T02:00:00Z"), seen: false},
    {uid: 100, subject: "社团招新", from: {name: "", address: "club@tsinghua.edu.cn"}, date: new Date("2026-09-10T02:00:00Z"), seen: true},
];

const fakeDetail = {
    subject: "教务处选课通知",
    from: "教务处 <jwc@tsinghua.edu.cn>",
    to: "dhl24@mails.tsinghua.edu.cn",
    date: new Date("2026-09-12T02:00:00Z"),
    text: "各位同学：请于本周五前完成选课确认。",
    attachments: [{filename: "选课指南.pdf", size: 102400}],
};

let lastListOpts: unknown;
const fakeClient = {
    listMessages: async (opts?: unknown) => {
        lastListOpts = opts;
        const kw = (opts as {keyword?: string})?.keyword;
        if (kw) return fakeSummaries.filter((m) => m.subject.includes(kw) || m.from.address.includes(kw));
        if ((opts as {unreadOnly?: boolean})?.unreadOnly) return fakeSummaries.filter((m) => !m.seen);
        return fakeSummaries;
    },
    getMessage: async (uid: number) => (uid === 101 ? fakeDetail : undefined),
};

const sentCalls: {to: string; cc?: string; subject: string; text: string}[] = [];
const fakeSender = {
    sendMail: async (opts: {to: string; cc?: string; subject: string; text: string}) => {
        sentCalls.push(opts);
    },
};

const getSkill = createGetEmailsSkill(fakeClient);
const sendSkill = createSendEmailSkill(fakeSender);

const execGet = async (input?: unknown) =>
    (await getSkill.execute(input)) as {success: boolean; data?: GetEmailsData; error?: {code: string; message: string}};
const execSend = async (input?: unknown) =>
    (await sendSkill.execute(input)) as {success: boolean; data?: SendEmailData; error?: {code: string; message: string}};

describe("get_emails Skill（假数据，无网络）", () => {
    it("列表模式：摘要 + 时间格式化 + 发件人展示", async () => {
        const r = await execGet();
        expect(r.success).toBe(true);
        expect(r.data!.mode).toBe("list");
        expect(r.data!.count).toBe(2);
        expect(r.data!.emails![0]).toMatchObject({
            uid: 101,
            subject: "教务处选课通知",
            from: "教务处 <jwc@tsinghua.edu.cn>",
            date: "2026-09-12 10:00",
            seen: false,
        });
        // 无显示名时只显示地址
        expect(r.data!.emails![1].from).toBe("club@tsinghua.edu.cn");
    });

    it("unreadOnly 与 keyword 透传给 client", async () => {
        let r = await execGet({unreadOnly: true});
        expect(r.data!.count).toBe(1);
        expect((lastListOpts as {unreadOnly?: boolean}).unreadOnly).toBe(true);
        r = await execGet({keyword: "选课"});
        expect(r.data!.count).toBe(1);
        r = await execGet({keyword: "不存在"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
    });

    it("详情模式：完整正文 + 附件；uid 不存在报 NOT_FOUND", async () => {
        let r = await execGet({uid: 101});
        expect(r.data!.mode).toBe("detail");
        expect(r.data!.detail!.body).toContain("选课确认");
        expect(r.data!.detail!.attachments[0].filename).toBe("选课指南.pdf");
        expect(r.data!.detail!.bodyTruncated).toBe(false);
        r = await execGet({uid: 999});
        expect(r.error!.code).toBe("NOT_FOUND");
    });

    it("非法输入校验", async () => {
        for (const input of [{limit: 0}, {limit: 51}, {uid: -1}, {keyword: 1}, {unreadOnly: "yes"}]) {
            const r = await execGet(input);
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });
});

describe("send_email Skill（假 client，无网络）", () => {
    it("成功发送：参数原样传给 client", async () => {
        const r = await execSend({
            to: "teacher@tsinghua.edu.cn",
            subject: "请假申请",
            text: "老师好，我因病请假一天。",
        });
        expect(r.success).toBe(true);
        expect(r.data!.message).toContain("teacher@tsinghua.edu.cn");
        const call = sentCalls.at(-1)!;
        expect(call.subject).toBe("请假申请");
        expect(call.text).toContain("请假");
    });

    it("支持逗号分隔多地址与抄送", async () => {
        const r = await execSend({
            to: "a@mails.tsinghua.edu.cn, b@mails.tsinghua.edu.cn",
            cc: "c@mails.tsinghua.edu.cn",
            subject: "s",
            text: "t",
        });
        expect(r.success).toBe(true);
        expect(sentCalls.at(-1)!.cc).toBe("c@mails.tsinghua.edu.cn");
    });

    it("地址格式非法被拒", async () => {
        for (const bad of ["not-an-email", "a@", "@b.com", "a b@c.com"]) {
            const r = await execSend({to: bad, subject: "s", text: "t"});
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });

    it("必填参数缺失被拒", async () => {
        for (const input of [{subject: "s", text: "t"}, {to: "a@b.com", text: "t"}, {to: "a@b.com", subject: "s"}]) {
            const r = await execSend(input);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });

    it("requiresConfirmation 标记为 true", () => {
        expect(sendSkill.requiresConfirmation).toBe(true);
    });
});
