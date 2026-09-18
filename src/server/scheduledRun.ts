import type {Agent} from "../harness/agentLoop";
import type {ToolCall} from "../harness/types";
import {taskSessionContext} from "../tasks/sessionContext";
import type {ScheduledRun, ScheduledTask} from "../tasks/scheduledTypes";
import {newId} from "../web/lib/history";
import {applyTurnEvent, finishTurn, turnText} from "../web/lib/turn";
import type {Message, Turn, Usage} from "../web/lib/types";
import type {WebDatabase} from "./webDatabase";
import {extractPayUrl, makeQrDataUrl} from "./toolResultExtras";

/** 定时任务自动放行的电费充值金额上限（元）：防模型误判金额，超出仍走 fail closed */
const SCHEDULED_RECHARGE_MAX_YUAN = 50;

/**
 * 定时任务无人值守时的写操作放行策略（fail closed 的唯一例外）：
 * 仅「电费充值下单」（recharge_electricity）且金额 ≤ 50 元时自动批准——
 * 该操作只生成支付宝付款码，用户手机扫码前钱不动、订单会自动过期，
 * 属于「用户在任务里预设金额、事后扫码才生效」的低风险操作。
 * 其余写操作（预约、发邮件、云盘写等）仍一律拒绝。
 */
export function shouldAutoApproveScheduledWrite(call: ToolCall): boolean {
    if (call.function.name !== "recharge_electricity") return false;
    try {
        const amount = (JSON.parse(call.function.arguments || "{}") as {amountYuan?: unknown}).amountYuan;
        return typeof amount === "number" && Number.isFinite(amount) && amount > 0 && amount <= SCHEDULED_RECHARGE_MAX_YUAN;
    } catch {
        return false;
    }
}

/** Persist background turns using the same timeline/context contract as interactive chat. */
export async function executeScheduledRun(database: WebDatabase, agent: Agent, task: ScheduledTask, run: ScheduledRun, signal: AbortSignal,
    attention: () => boolean) {
    const sessionId = run.sessionId!;
    const messageId = newId();
    let turn: Turn = {sessionId, messageId, startedAt: run.startedAt, status: "running", phase: "thinking", items: []};
    let usage: Usage | undefined;
    let lastCheckpoint = 0;
    database.updateSession(sessionId, session => ({...session, title: task.title, titleLlm: true,
        scheduledTaskId: task.id, scheduledRunId: run.id,
        messages: [{id: newId(), role: "user", text: task.prompt}]}));
    const checkpoint = () => {
        database.updateSession(sessionId, session => {
            const message: Message = {id: messageId, role: "bot", text: turnText(turn), turn, usage};
            return {...session, tokens: usage?.totalTokens ?? 0, messages: session.messages.some(item => item.id === messageId)
                ? session.messages.map(item => item.id === messageId ? message : item) : [...session.messages, message]};
        });
        lastCheckpoint = Date.now();
    };
    const send = (event: string, data: Record<string, unknown>) => {
        turn = applyTurnEvent(turn, {event, data});
        if (Date.now() - lastCheckpoint > 250 || ["answer", "done", "error"].includes(event)) checkpoint();
    };
    checkpoint();
    try {
        const result = await taskSessionContext.run(sessionId, () => agent.ask(
            `当前北京时间：${new Date(run.startedAt).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "short"})}。以此次执行时间为准理解今天、明天等相对日期。这是一次后台定时任务；需要用户确认的操作请说明并留待用户在本会话继续处理（例外：电费充值下单会自动生成付款码并展示给用户，扫码前钱不动，可直接执行）。\n\n${task.prompt}`, {
                accessMode: "request-approval", signal,
                onToken: text => send("token", {text}), onReasoning: text => send("reasoning", {text}),
                onToolEvent: event => send("tool", {...event}),
            }));
        usage = result.usage;
        // 付款码进执行记录（低电费任务自动下单的关键产物）：用户在任务历史里打开即可扫码
        let payUrl: string | undefined;
        for (const call of result.toolCalls) {
            payUrl ??= extractPayUrl(call.result);
            if (payUrl) {
                const dataUrl = await makeQrDataUrl(payUrl);
                send("qr", {url: payUrl, ...(dataUrl ? {dataUrl} : {})});
            }
        }
        send("answer", {text: result.answer});
        send("done", {});
        const failedTool = result.toolCalls.some(call => {
            try { return JSON.parse(call.result).success === false; } catch { return false; }
        });
        return {status: attention() ? "needs_attention" as const : failedTool ? "failed" as const : "completed" as const,
            summary: attention() ? "需要确认操作或重新认证，请打开会话继续处理。" : failedTool ? "部分工具执行失败，请打开会话查看详情。" : result.answer.slice(0, 200),
            ...(payUrl ? {payUrl} : {})};
    } catch (error) {
        if (!signal.aborted) send("error", {message: "执行未完成，请检查登录或模型连接后重试。"});
        throw error;
    } finally {
        if (turn.status === "running") turn = finishTurn(turn, signal.aborted ? "cancelled" : "error");
        checkpoint();
        const context = agent.snapshotMessages();
        // Agent.ask rolls back on error. Retain the prompt so this run can still be continued.
        const resumedContext = context.length > 1 ? context : [...context, {role: "user" as const, content: task.prompt}];
        if (context.length <= 1) agent.loadMessages(resumedContext);
        database.setContext(sessionId, resumedContext);
    }
}
