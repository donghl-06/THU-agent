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

    it("多标签页写入本地会话时先合并最新记录，避免旧快照覆盖新消息", () => {
        expect(html).toContain("function mergeSessionsState(local, remote)");
        expect(html).toContain("function mergeMessageRecords(");
        expect(html).toContain("function normalizeMessageRecords(records, sessionId)");
        expect(html).toContain("function legacyMessageId(record, sessionId, occurrence)");
        expect(html).toContain("id: node.dataset.messageId || newMessageId()");
        expect(html).toContain("function readSessionsState()");

        const persistSessions = /function persistSessions\(replace = false\) \{([\s\S]*?)\n\}/.exec(html)?.[1] ?? "";
        expect(persistSessions).toContain("mergeSessionsState(sessionsState, readSessionsState())");

        expect(html).toContain("function syncSessionsFromStorage(event)");
        expect(html).toContain('window.addEventListener("storage", syncSessionsFromStorage)');
        expect(html).toContain("if (!busy && authenticated)");
        expect(html).toContain("div.dataset.messageId = newMessageId();");
        expect(html).toContain("normalizeMessageRecords(records ?? [], sessionsState.activeId)");
        expect(html).toContain("div.dataset.messageId = record.id;");
        expect(html).toContain("deletedSessionIds");
        expect(html).toContain("persistSessions(true)");
    });

    it("多标签页消息合并保留双端追加并让完整回答覆盖半成品", () => {
        const functionSource = [
            /function legacyMessageId\(record, sessionId, occurrence\) \{[\s\S]*?\n\}/.exec(html)?.[0],
            /function normalizeMessageRecords\(records, sessionId\) \{[\s\S]*?\n\}/.exec(html)?.[0],
            /function mergeMessageRecords\(older, newer, sessionId\) \{[\s\S]*?\n\}/.exec(html)?.[0],
        ].join("\n");
        const mergeMessageRecords = new Function(
            "MAX_SAVED_MESSAGES",
            `${functionSource}; return mergeMessageRecords;`,
        )(100);

        const commonPrefix = [
            {id: "u1", role: "user", text: "第一个问题"},
            {id: "a1", role: "bot", text: "第一个回答"},
        ];
        const commonSuffix = [
            {id: "u3", role: "user", text: "共同的问题"},
            {id: "a3", role: "bot", text: "共同的回答"},
        ];
        const tabA = [...commonPrefix, {id: "ua", role: "user", text: "A 页新增"}, {id: "aa", role: "bot", text: "A 页回答"}, ...commonSuffix];
        const tabB = [...commonPrefix, {id: "ub", role: "user", text: "B 页新增"}, {id: "ab", role: "bot", text: "B 页回答"}, ...commonSuffix];
        const mergedBranches = mergeMessageRecords(tabA, tabB, "s_test");
        expect(mergedBranches.map((m: {text: string}) => m.text)).toEqual([
            "第一个问题",
            "第一个回答",
            "A 页新增",
            "A 页回答",
            "B 页新增",
            "B 页回答",
            "共同的问题",
            "共同的回答",
        ]);

        const partial = [{id: "stream", role: "bot", text: "部分"}];
        const complete = [{id: "stream", role: "bot", text: "这是完整回答"}];
        expect(mergeMessageRecords(partial, complete, "s_test")[0].text).toBe("这是完整回答");

        const legacyA = [{role: "user", text: "旧问题"}, {role: "bot", text: "旧回答"}];
        const legacyB = [...legacyA, {role: "user", text: "新增问题"}, {role: "bot", text: "新增回答"}];
        expect(mergeMessageRecords(legacyA, legacyB, "s_test")).toHaveLength(4);

        // 上一版曾写入“按数组下标”的旧 ID；不同内容不能因为下标相同而被合并掉。
        const indexedA = [{id: "s_test:legacy:0", role: "user", text: "第一条"}];
        const indexedB = [{id: "s_test:legacy:0", role: "user", text: "另一条"}];
        expect(mergeMessageRecords(indexedA, indexedB, "s_test")).toHaveLength(2);

        expect(mergeMessageRecords([{role: "bot", text: ""}], [], "s_test")).toHaveLength(0);
    });
});
