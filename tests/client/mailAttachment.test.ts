/**
 * selectAttachment 纯函数测试：index/filename/自动选图三种路径与歧义处理。
 */
import {describe, expect, it} from "vitest";
import {selectAttachment} from "../../src/client/mail/MailClient";
import {ThuError} from "../../src/client/errors";

const atts = [
    {filename: "课程二维码.jpg", contentType: "image/jpeg", content: Buffer.from("a"), size: 1},
    {filename: "选课指南.pdf", contentType: "application/pdf", content: Buffer.from("b"), size: 1},
    {filename: "群二维码-备用.png", contentType: "image/png", content: Buffer.from("c"), size: 1},
];

const code = (fn: () => unknown): string => {
    try {
        fn();
    } catch (e) {
        return (e as ThuError).code;
    }
    return "";
};

describe("selectAttachment", () => {
    it("index：1-based 取件，越界 NOT_FOUND", () => {
        expect(selectAttachment(atts, {index: 2}).filename).toBe("选课指南.pdf");
        expect(code(() => selectAttachment(atts, {index: 4}))).toBe("NOT_FOUND");
    });

    it("filename：精确优先，其次包含匹配", () => {
        expect(selectAttachment(atts, {filename: "课程二维码.jpg"}).contentType).toBe("image/jpeg");
        expect(selectAttachment(atts, {filename: "备用"}).filename).toBe("群二维码-备用.png");
    });

    it("filename：无命中 NOT_FOUND 并列出现有附件；多命中 AMBIGUOUS 带候选", () => {
        expect(code(() => selectAttachment(atts, {filename: "不存在"}))).toBe("NOT_FOUND");
        // 「二维码」命中两张图 → 歧义
        try {
            selectAttachment(atts, {filename: "二维码"});
            expect.unreachable();
        } catch (e) {
            expect((e as ThuError).code).toBe("AMBIGUOUS");
            expect((e as ThuError).message).toContain("课程二维码.jpg");
            expect((e as ThuError).message).toContain("群二维码-备用.png");
        }
    });

    it("无选择条件：唯一图片自动选中", () => {
        const oneImage = [atts[1], atts[0]];
        expect(selectAttachment(oneImage, {}).filename).toBe("课程二维码.jpg");
    });

    it("无选择条件：无图片 NOT_FOUND，多图片 AMBIGUOUS", () => {
        expect(code(() => selectAttachment([atts[1]], {}))).toBe("NOT_FOUND");
        expect(code(() => selectAttachment(atts, {}))).toBe("AMBIGUOUS");
    });
});
