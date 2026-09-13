/**
 * localPath（用户路径归一化）与 Content-Disposition 文件名解码测试。
 *
 * WSL 相关分支在本开发机（WSL2）上按真实环境断言；
 * 盘符翻译只断言「能翻成 /mnt/x/... 且分隔符归一」，不依赖某个具体盘一定存在。
 */
import {describe, expect, it} from "vitest";
import {homedir} from "node:os";
import {existsSync} from "node:fs";
import {resolveUserPath} from "../../src/utils/localPath";
import {decodeDispositionFilename} from "../../src/client/learn/downloadSession";

const onWsl = process.platform === "linux" && existsSync("/mnt/c");

describe("resolveUserPath", () => {
    it("~ 与 ~/ 展开到主目录", () => {
        expect(resolveUserPath("~")).toEqual({ok: true, path: homedir()});
        expect(resolveUserPath("~/Desktop")).toEqual({ok: true, path: `${homedir()}/Desktop`});
    });

    it("普通 Linux 路径原样返回", () => {
        expect(resolveUserPath("/tmp/a.pdf")).toEqual({ok: true, path: "/tmp/a.pdf"});
        expect(resolveUserPath("  /tmp/a.pdf  ")).toEqual({ok: true, path: "/tmp/a.pdf"});
    });

    it("空路径报错", () => {
        const r = resolveUserPath("   ");
        expect(r.ok).toBe(false);
    });

    it("Windows 盘符路径：WSL 下翻译为 /mnt/盘符/...", () => {
        const r = resolveUserPath("D:\\大学\\2026 秋\\hw3.pdf");
        if (onWsl && existsSync("/mnt/d")) {
            expect(r).toMatchObject({ok: true, path: "/mnt/d/大学/2026 秋/hw3.pdf"});
            if (r.ok) expect(r.note).toContain("翻译");
        } else if (onWsl) {
            // 盘未挂载：给出可操作的错误提示而不是静默写错地方
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.error).toContain("/mnt/d");
        } else {
            expect(r.ok).toBe(false);
        }
    });

    it("正斜杠的 Windows 路径同样翻译", () => {
        if (!onWsl || !existsSync("/mnt/c")) return;
        const r = resolveUserPath("C:/Users/dongh_o/Downloads");
        expect(r).toMatchObject({ok: true, path: "/mnt/c/Users/dongh_o/Downloads"});
    });
});

describe("decodeDispositionFilename（latin1/utf8 乱码还原）", () => {
    it("filename*=UTF-8'' 百分号编码直接解", () => {
        const d = "attachment; filename*=UTF-8''%E5%A4%A7%E7%BA%B2.doc";
        expect(decodeDispositionFilename(d)).toBe("大纲.doc");
    });

    it("latin1 读入的 UTF-8 中文文件名还原", () => {
        // undici 把 header 字节按 latin1 解码："大纲.doc" 变成 mojibake
        const mojibake = Buffer.from("大纲.doc", "utf8").toString("latin1");
        expect(decodeDispositionFilename(`attachment; filename="${mojibake}"`)).toBe("大纲.doc");
    });

    it("ASCII 文件名不受影响", () => {
        expect(decodeDispositionFilename('attachment; filename="report-final.pdf"')).toBe("report-final.pdf");
    });

    it("无文件名返回 undefined（调用方用课件标题兜底）", () => {
        expect(decodeDispositionFilename("attachment")).toBeUndefined();
        expect(decodeDispositionFilename("")).toBeUndefined();
    });

    it("非 UTF-8 编码（如 GBK）放弃还原", () => {
        // GBK 编码的"大纲"按 latin1→utf8 会产生替换符
        const gbkMojibake = Buffer.from([0xb4, 0xf3, 0xb8, 0xd9]).toString("latin1");
        expect(decodeDispositionFilename(`attachment; filename="${gbkMojibake}.doc"`)).toBeUndefined();
    });
});
