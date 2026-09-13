/** 将已通过 CLI 确认闸门的任务调用交给本机清灵的常驻调度器。 */
import {request} from "node:http";
import {config} from "../config/env";
import {fail, type SkillResult} from "../skills/base/types";

export interface TaskSkillClientOptions {
    serverUrl?: string;
    token?: string;
}

export async function callTaskSkill(
    name: string,
    input: unknown,
    opts: TaskSkillClientOptions = {},
): Promise<SkillResult> {
    const token = opts.token ?? config.ui.token;
    if (!token) return fail("TASK_SERVICE_AUTH_REQUIRED", "任务能力需要本机清灵 Web 服务。请在服务和 CLI 的 .env 中配置相同的 UI_TOKEN，并在网页完成登录。");
    let url: URL;
    try {
        url = new URL(opts.serverUrl ?? process.env.THU_SKILL_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3457"}`);
        if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
            || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
            throw new Error("invalid endpoint");
        }
        url.pathname = "/api/skills/tasks";
    } catch {
        return fail("TASK_SERVICE_CONFIG", "THU_SKILL_SERVER_URL 必须是本机回环 HTTP 地址，例如 http://127.0.0.1:3457。");
    }

    // node:http 直连本机，不受全局校园 HTTP 代理影响，不跟随重定向，也不重试写操作。
    return new Promise((resolve) => {
        const body = JSON.stringify({name, input, confirmedByUser: true});
        const unavailable = () => resolve(fail("TASK_SERVICE_UNAVAILABLE", "未收到任务服务的确定结果。请确认清灵 Web 服务正在运行；若刚才是创建/取消任务，先查询任务状态，不要自动重试。"));
        const req = request(url, {
            method: "POST",
            headers: {"Content-Type": "application/json", Authorization: `Bearer ${token}`},
            signal: AbortSignal.timeout(10_000),
        }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("error", unavailable);
            res.on("data", (chunk: string) => {
                text += chunk;
                if (text.length > 1_000_000) req.destroy();
            });
            res.on("end", () => {
                try {
                    const result = JSON.parse(text) as SkillResult;
                    if (!result || typeof result.success !== "boolean"
                        || (!result.success && typeof result.error?.code !== "string")) throw new Error("bad result");
                    if (res.statusCode !== 200 && result.success) throw new Error("bad status");
                    resolve(result);
                } catch {
                    unavailable();
                }
            });
        });
        req.on("error", unavailable);
        req.end(body);
    });
}
