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

    it("会话列表禁止横向溢出，删除按钮始终留在条目右侧", () => {
        const sessionList = /#session-list \{([\s\S]*?)\n  \}/.exec(html)?.[1] ?? "";
        expect(sessionList).toContain("min-width: 0");
        expect(sessionList).toContain("overflow-x: hidden");

        const sessionItem = /\.session-item \{([\s\S]*?)\n  \}/.exec(html)?.[1] ?? "";
        expect(sessionItem).toContain("box-sizing: border-box");
        expect(sessionItem).toContain("min-width: 0");

        const sessionTitle = /\.session-item \.s-title \{([\s\S]*?)\}/.exec(html)?.[1] ?? "";
        expect(sessionTitle).toContain("min-width: 0");
        expect(sessionTitle).toContain("text-overflow: ellipsis");
    });

    it("浏览器标签页跟随桌面生命周期并安装离线守卫", () => {
        expect(html).toContain('new EventSource("/api/events")');
        expect(html).toContain('addEventListener("shutdown"');
        expect(html).toContain("window.close()");
        expect(html).toContain("清灵后台未运行");
        expect(html).toContain('register("/service-worker.js")');
        expect(html).toContain('fetch("/api/capabilities", {cache: "no-store"})');
    });

    it("任务通知会回写到对应会话的聊天消息", () => {
        expect(html).toContain("function appendNotificationToSession");
        expect(html).toContain("appendNotificationToSession(n)");
        expect(html).toContain('addMsg("bot", text)');
        expect(html).toContain('session.messages.push({role: "bot", text})');
        expect(html).toContain("void pollNotifications();");
    });

    it("退出登录保留聊天记录，重新登录后可继续查看", () => {
        const logout = /async function logout\(\) \{([\s\S]*?)\n\}/.exec(html)?.[1] ?? "";
        expect(logout).toContain('fetch("/api/auth/logout"');
        expect(logout).toContain("saveChatHistory()");
        expect(logout).toContain("hideHistoryForLogout()");
        expect(logout).not.toContain("clearChatHistory()");
        expect(logout).toContain("历史对话已隐藏");
    });

    it("未登录时锁定历史渲染，登录后恢复当前会话消息", () => {
        const renderMessages = /function renderMessages\(records\) \{([\s\S]*?)\n\}/.exec(html)?.[1] ?? "";
        expect(renderMessages).toContain("if (!authenticated) return");

        const renderSessionList = /function renderSessionList\(\) \{([\s\S]*?)\n\}/.exec(html)?.[1] ?? "";
        expect(renderSessionList).toContain("if (!authenticated)");
        expect(renderSessionList).toContain("登录后可查看历史对话");

        const switchSession = /function switchSession\(id\) \{([\s\S]*?)\n\}/.exec(html)?.[1] ?? "";
        expect(switchSession).toContain("if (!authenticated)");

        expect(html).toContain("function showHistoryAfterLogin()");
        expect(html).toContain("renderMessages(activeSession()?.messages ?? [])");
        expect(html).toContain("if (authenticated) showHistoryAfterLogin()");
    });
});
