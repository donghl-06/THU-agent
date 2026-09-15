import {describe, expect, it} from "vitest";
import {mergeHistory, mergeMessages, normalizeMessages, parseHistory} from "../../src/web/lib/history";
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
        const local: SessionsState = {activeId: "gone", deletedSessionIds: [], sessions: [{id: "gone", title: "旧对话", createdAt: 1, messages: []}, {id: "kept", title: "保留", createdAt: 2, messages: []}]};
        const merged = mergeHistory(local, {activeId: "kept", deletedSessionIds: ["gone"], sessions: []});
        expect(merged.sessions.map(s => s.id)).toEqual(["kept"]);
        expect(merged.activeId).toBe("kept");
        expect(merged.deletedSessionIds).toContain("gone");
    });

    it("损坏的历史不会阻止界面启动", () => {
        expect(parseHistory("broken").sessions).toEqual([]);
        expect(parseHistory(JSON.stringify({sessions: [null, {id: 123}, {id: "valid", messages: "bad"}]})).sessions).toHaveLength(1);
    });
});
