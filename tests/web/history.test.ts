import {describe, expect, it} from "vitest";
import {mergeHistory, mergeMessages, normalizeMessages, parseHistory, updateSession} from "../../src/web/lib/history";
import type {Message, SessionsState} from "../../src/web/lib/types";

const message = (id: string, text: string): Message => ({id, role: "bot", text});
describe("React 会话数据迁移与合并", () => {
    it("两标签页分叉追加都保留，较新回答覆盖部分内容", () => {
        const prefix = [message("u1", "问题"), message("a1", "回答")];
        const suffix = [message("u3", "后续问题"), message("a3", "后续回答")];
        const a = [...prefix, message("a", "A 的新增"), ...suffix];
        const b = [...prefix, message("b", "B 的新增"), ...suffix];
        expect(mergeMessages(a, b, "s1").map(m => m.id)).toEqual(["u1", "a1", "a", "b", "u3", "a3"]);
        expect(mergeMessages([message("stream", "部分")], [message("stream", "完整回答")], "s1")[0].text).toBe("完整回答");
    });

    it("迁移旧版消息 ID，保留重复文字和无文本图片，忽略空回答", () => {
        const legacy = [{role: "user", text: "你好"}, {role: "bot", text: "你好"}, {role: "user", text: "你好"}] as Message[];
        const migrated = normalizeMessages(legacy, "s1");
        expect(new Set(migrated.map(m => m.id)).size).toBe(3);
        expect(normalizeMessages(legacy, "s1")).toEqual(migrated);
        expect(normalizeMessages([message("empty", "")], "s1")).toEqual([]);
        expect(normalizeMessages([{id: "img", role: "user", text: "", imageCount: 1}], "s1")).toHaveLength(1);
        expect(mergeMessages([{id: "s1:legacy:0", role: "user", text: "旧问题"}], [{id: "s1:legacy:0", role: "user", text: "新问题"}], "s1")).toHaveLength(2);
    });

    it("其他标签页删除的会话不会复活，活动会话回退", () => {
        const local: SessionsState = {activeId: "gone", deletedSessionIds: [], sessions: [{id: "gone", title: "旧对话", createdAt: 1, messages: [message("a", "旧回答")]}, {id: "kept", title: "保留", createdAt: 2, messages: [message("b", "保留回答")]}]};
        const merged = mergeHistory(local, {activeId: "kept", deletedSessionIds: ["gone"], sessions: []});
        expect(merged.sessions.map(s => s.id)).toEqual(["kept"]);
        expect(merged.activeId).toBe("kept");
        expect(merged.deletedSessionIds).toContain("gone");
    });

    it("损坏的历史不会阻止界面启动", () => {
        expect(parseHistory("broken").sessions).toEqual([]);
        expect(parseHistory(JSON.stringify({sessions: [null, {id: 123}, {id: "valid", messages: "bad"}]})).sessions).toHaveLength(0);
        const state = parseHistory(JSON.stringify({sessions: [{id: "valid", messages: [{role: "bot", text: "仍可阅读", turn: {items: null}}]}]}));
        expect(state.sessions[0].messages[0].text).toBe("仍可阅读");
        expect(state.sessions[0].messages[0].turn).toBeUndefined();
    });

    it("清理空会话并保留无文字图片和未发送草稿的活动位置", () => {
        const state = parseHistory(JSON.stringify({activeId: "draft", sessions: [
            {id: "empty", messages: []},
            {id: "empty-answer", messages: [message("a", "")]},
            {id: "image", messages: [{id: "img", role: "user", text: "", imageCount: 1}]},
        ]}));
        expect(state.sessions.map(s => s.id)).toEqual(["image"]);
        expect(state.activeId).toBe("draft");
        expect(parseHistory(JSON.stringify(state)).activeId).toBe("draft");
    });

    it("跨标签同步不会打断新对话草稿，首条消息才创建历史", () => {
        const draft: SessionsState = {activeId: "draft", sessions: [], deletedSessionIds: []};
        const remote: SessionsState = {activeId: "remote", deletedSessionIds: [], sessions: [
            {id: "remote", title: "另一页", createdAt: 1, messages: [message("a", "回答")]},
            {id: "old-empty", title: "新对话", createdAt: 2, messages: []},
        ]};
        const merged = mergeHistory(draft, remote);
        expect(merged.activeId).toBe("draft");
        expect(merged.sessions.map(s => s.id)).toEqual(["remote"]);
        const sent = updateSession(merged, "draft", session => ({...session, messages: [{id: "u", role: "user", text: "第一个问题"}]}));
        expect(sent.sessions.map(s => s.id)).toEqual(["remote", "draft"]);
        expect(sent.sessions[1].messages[0].text).toBe("第一个问题");
        const deleted = mergeHistory(draft, {...draft, deletedSessionIds: ["draft"]});
        expect(deleted.activeId).not.toBe("draft");
        expect(deleted.sessions).toEqual([]);
    });
});
