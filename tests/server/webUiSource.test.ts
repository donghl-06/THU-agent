import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const html = readFileSync(join(process.cwd(), "src", "server", "public", "index.html"), "utf8");

describe("Web UI 请求状态", () => {
    it("强制滚动会同步恢复自动跟随，Thinking Card 创建后进入视野", () => {
        const scrollDown = /function scrollDown\(force = false\) \{([\s\S]*?)\n\}/.exec(html)?.[1] ?? "";
        expect(scrollDown).toContain("followScroll = true");
        expect(scrollDown).toContain("scrollBtn.hidden = true");

        const createThinkingCard = /function createThinkingCard\(\) \{([\s\S]*?)\n\}/.exec(html)?.[1] ?? "";
        expect(createThinkingCard).toContain("scrollDown(true)");
    });

    it("首个流式 token 只切换生成状态，不提前删除 Thinking Card", () => {
        const ensureBot = /const ensureBot = \(\) => \{([\s\S]*?)\n    \};/.exec(html)?.[1] ?? "";
        expect(ensureBot).not.toContain("thinking.dismiss()");

        const tokenBranch = /if \(ev === "token"\) \{([\s\S]*?)\n        \} else if \(ev === "tool"\)/.exec(html)?.[1] ?? "";
        expect(tokenBranch).toContain("thinking.markGenerating()");
        expect(tokenBranch).not.toContain("thinking.dismiss()");
    });

    it("桌面端会话侧栏支持拖拽调宽并持久化", () => {
        expect(html).toContain('id="sidebar-resizer"');
        expect(html).toContain("--sidebar-width");
        expect(html).toContain('"sidebar-width"');
        expect(html).toContain("setPointerCapture");
        expect(html).toContain("clampSidebarWidth");
        expect(html).toContain("#sidebar-resizer { display: none; }");
    });
});
