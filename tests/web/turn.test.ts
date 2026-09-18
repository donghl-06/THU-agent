import {describe, expect, it} from "vitest";
import {applyTurnEvent, finishTurn, turnText} from "../../src/web/lib/turn";
import {mergeHistory, parseHistory} from "../../src/web/lib/history";
import type {Turn} from "../../src/web/lib/types";

const initial = (): Turn => ({sessionId: "session", messageId: "answer", startedAt: 1, status: "running", phase: "thinking", items: []});

describe("Agent turn 时间线", () => {
    it("交错的思考、正文、工具按创建顺序保存，最终快照替换尾部而不重复", () => {
        let turn = initial();
        const send = (event: string, data: Record<string, unknown>) => { turn = applyTurnEvent(turn, {event, data}); };
        send("reasoning", {text: "先查"});
        send("reasoning", {text: "课程"});
        send("token", {text: "我来查询。"});
        send("tool", {phase: "start", name: "get_schedule", toolCallId: "a"});
        send("tool", {phase: "end", name: "get_schedule", toolCallId: "a", success: true});
        send("reasoning", {text: "再查地点"});
        send("token", {text: "正在核对。"});
        send("tool", {phase: "start", name: "get_classroom_state", toolCallId: "b"});
        send("tool", {phase: "end", name: "get_classroom_state", toolCallId: "b", success: true});
        send("reasoning", {text: "已核对"});
        send("token", {text: "最终"});
        send("token", {text: "回答"});
        const tailId = turn.items.at(-1)!.id;
        send("answer", {text: "最终回答。"});
        expect(turn.status).toBe("running");
        expect(turn.items.map(item => item.kind)).toEqual(["reasoning", "text", "tool", "reasoning", "text", "tool", "reasoning", "text"]);
        expect(turn.items[0]).toMatchObject({text: "先查课程", status: "done"});
        expect(turn.items[1]).toMatchObject({text: "我来查询。"});
        expect(turn.finalItemId).toBe(tailId);
        expect(turnText(turn)).toBe("最终回答。");
        send("done", {});
        expect(turn.status).toBe("completed");
        expect(turn.items.every(item => item.kind === "qr" || item.status === "done")).toBe(true);
        const record = {activeId: "session", deletedSessionIds: [], sessions: [{id: "session", title: "测试", createdAt: 1, messages: [{id: "answer", role: "bot", text: turnText(turn), turn}]}]};
        expect(parseHistory(JSON.stringify(record)).sessions[0].messages[0].turn).toEqual(turn);
    });

    it("同名并行工具逆序完成时，只更新匹配的调用且不移动位置", () => {
        let turn = initial();
        for (const toolCallId of ["first", "second"]) turn = applyTurnEvent(turn, {event: "tool", data: {phase: "start", name: "get_schedule", toolCallId}});
        const ids = turn.items.map(item => item.id);
        turn = applyTurnEvent(turn, {event: "tool", data: {phase: "end", name: "get_schedule", toolCallId: "second", success: false, ms: 100}});
        expect(turn.items[0]).toMatchObject({status: "running"});
        expect(turn.items[1]).toMatchObject({status: "error", ms: 100});
        expect(turn.items.map(item => item.id)).toEqual(ids);
        expect(turn.phase).toBe("tool");
        turn = applyTurnEvent(turn, {event: "tool", data: {phase: "end", name: "get_schedule", toolCallId: "first", success: true}});
        expect(turn.phase).toBe("thinking");
    });

    it("取消保留纯思考与未完成工具，刷新后也不会丢失或冒充最终回复", () => {
        let turn = applyTurnEvent(initial(), {event: "reasoning", data: {text: "收到的思考"}});
        turn = applyTurnEvent(turn, {event: "tool", data: {phase: "start", name: "get_schedule"}});
        turn = finishTurn(turn, "cancelled", 500);
        expect(turnText(turn)).toBe("");
        expect(turn.finalItemId).toBeUndefined();
        expect(turn.items[1]).toMatchObject({status: "interrupted"});
        const state = parseHistory(JSON.stringify({activeId: "session", sessions: [{id: "session", createdAt: 1, messages: [{role: "bot", text: "", turn}]}]}));
        expect(state.sessions[0].messages[0].turn).toEqual(turn);
        expect(applyTurnEvent(turn, {event: "token", data: {text: "迟到的内容"}})).toBe(turn);
    });

    it("非流式快照也成为最终回复；相同毫秒的旧存储不能覆盖完成态", () => {
        const partial = applyTurnEvent(initial(), {event: "reasoning", data: {text: "思考"}});
        const complete = applyTurnEvent(applyTurnEvent(partial, {event: "answer", data: {text: "回复"}}), {event: "done", data: {}});
        const history = (turn: Turn) => ({activeId: "session", deletedSessionIds: [], sessions: [{id: "session", title: "测试", createdAt: 1, updatedAt: 2, messages: [{id: "answer", role: "bot" as const, text: turnText(turn), turn}]}]});
        expect(mergeHistory(history(complete), history(partial)).sessions[0].messages[0].turn?.status).toBe("completed");
        expect(complete.items).toHaveLength(2);
    });
});
