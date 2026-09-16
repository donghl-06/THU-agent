/** 外部 Agent 的任务专用入口：本机、访问口令、登录态和逐次确认均须满足。 */
import type {IncomingMessage, ServerResponse} from "node:http";
import {createTaskSkills} from "../tasks/createTaskSkills";
import {taskSessionContext} from "../tasks/sessionContext";
import type {TaskScheduler} from "../tasks/scheduler";
import {fail, type SkillResult} from "../skills/base/types";

export async function handleTaskSkillCall(
    req: IncomingMessage,
    res: ServerResponse,
    opts: {scheduler?: TaskScheduler; authenticated: boolean; token: string},
): Promise<void> {
    const send = (status: number, result: SkillResult) => {
        res.writeHead(status, {"Content-Type": "application/json"});
        res.end(JSON.stringify(result));
    };
    const address = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) || req.headers.origin
        || !opts.token || req.headers.authorization !== `Bearer ${opts.token}`) {
        send(403, fail("TASK_SERVICE_AUTH_REQUIRED", "本接口仅接受携带正确 UI_TOKEN 的本机 Agent 请求。"));
        return;
    }
    if (!opts.authenticated) {
        send(401, fail("AUTH_REQUIRED", "请先在清灵 Web 页面登录清华账号，再使用任务能力。"));
        return;
    }
    if (!opts.scheduler) {
        send(503, fail("SCHEDULER_UNAVAILABLE", "此服务未装配任务调度器。"));
        return;
    }
    let parsed: {name?: unknown; input?: unknown; confirmedByUser?: unknown};
    try {
        if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new Error("content type");
        let body = "";
        let bytes = 0;
        req.setEncoding("utf8");
        for await (const chunk of req) {
            body += chunk;
            bytes += Buffer.byteLength(chunk);
            if (bytes > 16_384) throw new Error("body too large");
        }
        parsed = JSON.parse(body);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("bad object");
        if (parsed.input !== undefined && (!parsed.input || typeof parsed.input !== "object" || Array.isArray(parsed.input))) {
            throw new Error("bad input");
        }
    } catch {
        send(400, fail("INVALID_INPUT", "请提交包含 name 和对象 input 的 JSON（最多 16 KB）。"));
        return;
    }
    const skill = createTaskSkills(opts.scheduler).find((candidate) => candidate.name === parsed.name);
    if (!skill) {
        send(400, fail("UNKNOWN_SKILL", "本接口只提供任务能力，请通过 CLI list 查看工具名称。"));
        return;
    }
    if (skill.requiresConfirmation && parsed.confirmedByUser !== true) {
        send(403, fail("CONFIRMATION_REQUIRED", "请先取得用户对本次任务参数的明确确认。"));
        return;
    }
    try {
        const result = await taskSessionContext.run("external_skill", () => skill.execute(parsed.input ?? {}));
        send(200, result);
    } catch {
        send(500, fail("INTERNAL_ERROR", "任务操作结果不确定，请先查询状态，不要自动重试。"));
    }
}
