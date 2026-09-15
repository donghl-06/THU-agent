/**
 * extractInlineImages 测试（纯函数，无网络）。
 */
import {describe, expect, it} from "vitest";
import {extractInlineImages} from "../../src/utils/htmlImages";

const BASE = "https://learn.tsinghua.edu.cn";

describe("extractInlineImages", () => {
    it("img 标签换成 [图片N] 占位，URL 按出现顺序收集", () => {
        const html = `<p>课表如下：</p><p><img src="https://learn.tsinghua.edu.cn/upload/a.jpg" alt="课表"></p><p>另见<img src='https://learn.tsinghua.edu.cn/upload/b.png'/>这张图</p>`;
        const {text, images} = extractInlineImages(html, BASE);
        expect(images).toEqual([
            {index: 1, url: "https://learn.tsinghua.edu.cn/upload/a.jpg"},
            {index: 2, url: "https://learn.tsinghua.edu.cn/upload/b.png"},
        ]);
        expect(text).toContain("[图片1]");
        expect(text).toContain("[图片2]");
        expect(text).not.toContain("<img");
        expect(text).toContain("课表如下");
    });

    it("相对路径按 baseUrl 解析成绝对 URL", () => {
        const {images} = extractInlineImages(`<img src="/upload/2026/qr.png">`, BASE);
        expect(images[0].url).toBe("https://learn.tsinghua.edu.cn/upload/2026/qr.png");
    });

    it("无引号 src 也能识别", () => {
        const {images} = extractInlineImages(`<img src=/upload/c.gif width=100>`, BASE);
        expect(images).toEqual([{index: 1, url: "https://learn.tsinghua.edu.cn/upload/c.gif"}]);
    });

    it("data: URI 与非法 URL 直接丢弃，不留占位", () => {
        const {text, images} = extractInlineImages(
            `<p>x</p><img src="data:image/png;base64,iVBORw0KGgo="><img src="http://exa mple.com/坏.png">`,
            BASE,
        );
        expect(images).toEqual([]);
        expect(text).toBe("x");
    });

    it("空/无图正文返回空清单", () => {
        expect(extractInlineImages(undefined, BASE)).toEqual({text: "", images: []});
        expect(extractInlineImages(`<p>纯文字</p>`, BASE).images).toEqual([]);
    });
});
