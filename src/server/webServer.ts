/**
 * Web UI 服务端：单用户本地 HTTP + SSE 流式（plan4ai.md 层次：Harness 不动，
 * 这是新加的 server 适配层）。
 *
 * 安全模型（单用户红线）：
 *   - 只监听 127.0.0.1，不对局域网开放——本机浏览器才能连
 *   - 凭证只在后端进程里（.env），前端永远拿不到
 *   - 写操作确认走 SSE 推送 + /api/confirm 应答的桥，前端不点同意就不执行
 *
 * 接口：
 *   GET  /              → 单页前端
 *   POST /api/chat      → {question} → SSE 流，事件：
 *       token   {text}                    回答的流式片段
 *       tool    {phase,name,ms?,success?} 工具进度（start/end）
 *       confirm {id,name,args}            写操作待确认（前端弹窗）
 *       qr      {url, dataUrl?}           支付二维码（data URL 图片）
 *       answer  {text}                    最终完整回答（前端校对用）
 *       done    {}                        本轮结束
 *       error   {message}                 出错
 *   POST /api/confirm   → {id, approved} 应答确认请求
 *
 * 并发：单用户一次只跑一个问题，进行中再来返回 409。
 * 确认桥原理：Agent 的 ConfirmFn 构造时绑定为一个"转发器"，每轮 /api/chat
 * 把转发目标切到本轮 SSE 连接的桥上（busy 互斥保证同时只有一轮）。
 */
import {createServer, type IncomingMessage, type ServerResponse, type Server} from "node:http";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import type {Agent} from "../harness/agentLoop";
import type {ConfirmFn} from "../harness/toolRegistry";

/** 确认请求 5 分钟不应答按拒绝处理（防 Promise 悬挂） */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingConfirm {
    resolve: (approved: boolean) => void;
    timer: NodeJS.Timeout;
}

/** 把支付链接转成二维码 data URL（qrcode 为可选依赖：装了就发图，没装前端只显示链接） */
async function makeQrDataUrl(url: string): Promise<string | undefined> {
    try {
        const qrcode = await import("qrcode");
        return await qrcode.toDataURL(url, {width: 320, margin: 1});
    } catch {
        return undefined;
    }
}

/** 从工具结果 JSON 里找支付链接（电费等充值技能会返回 payUrl） */
function extractPayUrl(toolResultJson: string): string | undefined {
    try {
        const parsed = JSON.parse(toolResultJson) as {success?: boolean; data?: {payUrl?: string}};
        if (parsed.success && typeof parsed.data?.payUrl === "string") return parsed.data.payUrl;
    } catch { /* 不是 JSON 或没有 payUrl */ }
    return undefined;
}

function sseSend(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
    let body = "";
    for await (const chunk of req) body += chunk;
    return body;
}

export interface WebServerOptions {
    port?: number;
    /** 单页 HTML 的路径（测试可注入临时文件） */
    indexHtmlPath?: string;
}

/**
 * 创建（但不启动）Web 服务。
 * @param agentFactory 用给定的 ConfirmFn 构造会话 Agent；只会被调用一次（惰性）
 */
export function createWebServer(
    agentFactory: (confirm: ConfirmFn) => Agent,
    opts: WebServerOptions = {},
): Server {
    const port = opts.port ?? 3457;
    const indexPath = opts.indexHtmlPath ?? join(import.meta.dirname, "public", "index.html");
    const indexHtml = readFileSync(indexPath, "utf8");

    // 单用户会话：整个服务共享一个 Agent（多轮对话靠它的 messages 延续）
    let agent: Agent | undefined;
    /** 当前轮的确认桥（busy 互斥保证只有一轮在跑） */
    let currentConfirm: ConfirmFn = async () => false;
    const delegatingConfirm: ConfirmFn = (call, skill) => currentConfirm(call, skill);
    /** 进行中的确认请求（id → 应答器） */
    const pendingConfirms = new Map<string, PendingConfirm>();
    let confirmSeq = 0;
    let busy = false;

    const handleChat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (busy) {
            res.writeHead(409).end("another question is in flight");
            return;
        }
        let question: string;
        try {
            const parsed = JSON.parse(await readBody(req)) as {question?: unknown};
            if (typeof parsed.question !== "string" || !parsed.question.trim()) throw new Error();
            question = parsed.question.trim();
        } catch {
            res.writeHead(400).end("question required");
            return;
        }

        busy = true;
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        // 本轮确认桥：推 SSE confirm 事件，挂起等 /api/confirm
        currentConfirm = (call, skill) =>
            new Promise<boolean>((resolve) => {
                const id = `cf_${++confirmSeq}`;
                const timer = setTimeout(() => {
                    pendingConfirms.delete(id);
                    resolve(false); // 超时按拒绝
                }, CONFIRM_TIMEOUT_MS);
                pendingConfirms.set(id, {resolve, timer});
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
                } catch { /* 参数不是 JSON 就展示空表 */ }
                sseSend(res, "confirm", {id, name: skill.name, args});
            });

        try {
            agent ??= agentFactory(delegatingConfirm);
            const result = await agent.ask(question, {
                onToken: (text) => sseSend(res, "token", {text}),
                onToolEvent: (e) => sseSend(res, "tool", e),
            });
            // 工具结果里有支付链接的，生成二维码推给前端
            for (const t of result.toolCalls) {
                const payUrl = extractPayUrl(t.result);
                if (payUrl) {
                    const dataUrl = await makeQrDataUrl(payUrl);
                    sseSend(res, "qr", {url: payUrl, ...(dataUrl ? {dataUrl} : {})});
                }
            }
            sseSend(res, "answer", {text: result.answer});
            sseSend(res, "done", {});
        } catch (e) {
            sseSend(res, "error", {message: (e as Error).message});
        } finally {
            busy = false;
            currentConfirm = async () => false;
            res.end();
        }
    };

    const handleConfirm = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        let parsed: {id?: string; approved?: boolean};
        try {
            parsed = JSON.parse(await readBody(req));
        } catch {
            res.writeHead(400).end("bad json");
            return;
        }
        const pending = parsed.id ? pendingConfirms.get(parsed.id) : undefined;
        if (!pending) {
            res.writeHead(404).end("confirm not found or expired");
            return;
        }
        clearTimeout(pending.timer);
        pendingConfirms.delete(parsed.id!);
        pending.resolve(parsed.approved === true);
        res.writeHead(200, {"Content-Type": "application/json"}).end("{}");
    };

    return createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
            if (req.method === "GET" && url.pathname === "/") {
                res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
                res.end(indexHtml);
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/chat") return handleChat(req, res);
            if (req.method === "POST" && url.pathname === "/api/confirm") return handleConfirm(req, res);
            res.writeHead(404).end("not found");
        })().catch((e) => {
            if (!res.headersSent) res.writeHead(500);
            res.end(String(e));
        });
    });
}
