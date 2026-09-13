/**
 * show_email_image Skill 测试（假 client + 真实 TempImageStore 临时目录，无网络）。
 */
import {afterEach, describe, expect, it} from "vitest";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createShowEmailImageSkill, type ShowEmailImageData} from "../../src/skills/mail/showEmailImage";
import {TempImageStore} from "../../src/utils/tempImageStore";
import {ThuError} from "../../src/client/errors";

const qrBytes = Buffer.from("fake-jpeg-bytes");
const fakeAttachment = {
    filename: "智能电子产品-课程二维码.jpg",
    contentType: "image/jpeg",
    content: qrBytes,
    size: qrBytes.length,
};

let lastSel: unknown;
const fakeClient = {
    getAttachment: async (uid: number, sel?: unknown) => {
        lastSel = sel;
        if (uid === 999) return undefined;
        if (uid === 998) throw new ThuError("AMBIGUOUS", "多张图片，请指定");
        if (uid === 997) return {...fakeAttachment, filename: "选课指南.pdf", contentType: "application/pdf"};
        return fakeAttachment;
    },
};

let dir = "";
let store: TempImageStore;
afterEach(() => {
    if (dir) rmSync(dir, {recursive: true, force: true});
    dir = "";
});

const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "qingling-showimg-test-"));
    store = new TempImageStore(dir);
    return createShowEmailImageSkill(fakeClient, store);
};

const exec = async (skill: ReturnType<typeof setup>, input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: ShowEmailImageData; error?: {code: string; message: string}};

describe("show_email_image Skill（假数据，无网络）", () => {
    it("成功：落临时文件、返回 URL 与 markdown，URL 里的 token 可取件", async () => {
        const skill = setup();
        const r = await exec(skill, {uid: 123});
        expect(r.success).toBe(true);
        expect(r.data!.filename).toBe("智能电子产品-课程二维码.jpg");
        expect(r.data!.imageUrl).toMatch(/^\/api\/temp-image\//);
        expect(r.data!.markdown).toBe(`![智能电子产品-课程二维码.jpg](${r.data!.imageUrl})`);
        // token 对应的文件真实存在，且内容一致
        const token = r.data!.imageUrl.split("/").pop()!;
        const entry = store.peek(token)!;
        expect(entry.contentType).toBe("image/jpeg");
        expect(existsSync(entry.path)).toBe(true);
        expect(store.consume(token)).toBe(true);
        expect(store.pendingCount).toBe(0);
    });

    it("filename/index 选择条件透传给 client", async () => {
        const skill = setup();
        await exec(skill, {uid: 123, filename: "二维码", index: 1});
        expect(lastSel).toEqual({filename: "二维码", index: 1});
    });

    it("无图片通道（CLI/MCP）报 NOT_SUPPORTED", async () => {
        const skill = createShowEmailImageSkill(fakeClient);
        const r = await exec(skill, {uid: 123});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_SUPPORTED");
    });

    it("邮件不存在 NOT_FOUND；选择歧义透传 AMBIGUOUS", async () => {
        const skill = setup();
        expect((await exec(skill, {uid: 999})).error!.code).toBe("NOT_FOUND");
        expect((await exec(skill, {uid: 998})).error!.code).toBe("AMBIGUOUS");
    });

    it("非图片附件被拒并提示改用下载", async () => {
        const skill = setup();
        const r = await exec(skill, {uid: 997});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("不是图片");
    });

    it("非法输入：uid 非正整数、index 非正整数", async () => {
        const skill = setup();
        for (const input of [{uid: -1}, {uid: "abc"}, {uid: 1, index: 0}, {}]) {
            const r = await exec(skill, input);
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });

    it("不需要确认（只读性质的展示操作）", () => {
        expect(setup().requiresConfirmation).toBeFalsy();
    });
});
