/**
 * Web UI 服务端：单用户本地 HTTP + SSE 流式（plan4ai.md 层次：Harness 不动，
 * 这是新加的 server 适配层）。
 *
 * 安全模型（单用户红线）：
 *   - 只监听 127.0.0.1，不对局域网开放——本机浏览器才能连
 *   - 登录凭证只通过本机回环地址传给后端，前端不持久化
 *   - 写操作确认走 SSE 推送 + /api/confirm 应答的桥，前端不点同意就不执行
 *
 * 接口：
 *   GET  /              → 单页前端
 *   GET  /api/capabilities → {vision}  前端据此显隐图片上传入口
 *   POST /api/chat      → {question, images?} → SSE 流，事件：
 *       （images 为 data URL 数组，最多 4 张、每张 base64 不超过 6MB 字符；
 *         仅当端点支持 vision 时可用，见 config.llm.vision）
 *       token   {text}                    回答的流式片段
 *       tool    {phase,name,ms?,success?} 工具进度（start/end）
 *       confirm {id,name,args}            写操作待确认（前端弹窗）
 *       auth    {phase,...}                二次认证交互（前端弹窗）
 *       qr      {url, dataUrl?}           支付二维码（data URL 图片）
 *       payform {html}                    自动提交的支付表单（前端渲染"前往支付"按钮，新窗口提交到学校支付平台）
 *       answer  {text}                    最终完整回答（前端校对用）
 *       done    {}                        本轮结束
 *       error   {message}                 出错
 *   POST /api/confirm   → {id, approved} 应答确认请求
 *   POST /api/auth/login  → {username, password} → SSE 登录流
 *   GET  /api/auth/status → {authenticated}
 *   POST /api/auth/logout → 清除本地登录会话
 *   POST /api/auth/method → {id, method} 选择二次认证方式
 *   POST /api/auth/code   → {id, code}   提交二次验证码
 *   POST /api/auth/cancel → {id}         取消二次认证
 *
 * 并发：单用户一次只跑一个问题，进行中再来返回 409。
 * 确认桥原理：Agent 的 ConfirmFn 构造时绑定为一个"转发器"，每轮 /api/chat
 * 把转发目标切到本轮 SSE 连接的桥上（busy 互斥保证同时只有一轮）。
 */
import {createServer, type IncomingMessage, type ServerResponse, type Server} from "node:http";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import type {Agent} from "../harness/agentLoop";
import type {ConfirmFn} from "../harness/toolRegistry";
import {config} from "../config/env";
import type {LoginCredentials, TwoFactorHooks} from "../client/auth";

/** 确认请求 5 分钟不应答按拒绝处理（防 Promise 悬挂） */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
/** 图片上传限制：最多 4 张，每张 base64 字符数 ≤ 6M（≈4.5MB 原图），总 body ≤ 25MB */
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 6_000_000;
const MAX_BODY_CHARS = 25_000_000;
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
type AuthMethod = "totp" | "mobile" | "wechat";

interface PendingAuthBase {
    id: string;
    timer: NodeJS.Timeout;
}

type PendingAuth =
    | (PendingAuthBase & {
        phase: "method";
        methods: AuthMethod[];
        resolve: (method: AuthMethod | undefined) => void;
    })
    | (PendingAuthBase & {
        phase: "code";
        resolve: (code: string | undefined) => void;
    });

/** 校验图片数组，返回错误消息（合法返回 undefined） */
function validateImages(images: unknown): string | undefined {
    if (images === undefined) return undefined;
    if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES) {
        return `images 需为 1~${MAX_IMAGES} 个元素的数组`;
    }
    for (const img of images) {
        if (typeof img !== "string" || !IMAGE_DATA_URL_RE.test(img)) {
            return "图片必须是 data:image/(png|jpeg|webp|gif);base64 格式";
        }
        if (img.length > MAX_IMAGE_CHARS) {
            return "单张图片过大（base64 超过 6MB），请压缩后再发";
        }
    }
    return undefined;
}

function maskPhone(phone: string | null): string | undefined {
    if (!phone) return undefined;
    const digits = phone.replace(/\D/g, "");
    return digits.length >= 4 ? `****${digits.slice(-4)}` : "已绑定手机号";
}

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

/** 从工具结果 JSON 里找自动提交的支付表单 HTML（体育订单 form 模式） */
function extractPayFormHtml(toolResultJson: string): string | undefined {
    try {
        const parsed = JSON.parse(toolResultJson) as {success?: boolean; data?: {payFormHtml?: string}};
        if (parsed.success && typeof parsed.data?.payFormHtml === "string") return parsed.data.payFormHtml;
    } catch { /* 同上 */ }
    return undefined;
}

function extractAuthFailure(toolResultJson: string): string | undefined {
    try {
        const parsed = JSON.parse(toolResultJson) as {success?: boolean; error?: {code?: string; message?: string}};
        if (!parsed.success && (parsed.error?.code === "AUTH_REQUIRED" || parsed.error?.code === "AUTH_FAILED")) {
            return parsed.error.message;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function sseSend(res: ServerResponse, event: string, data: unknown): void {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
    let body = "";
    for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY_CHARS) throw new Error("body too large");
    }
    return body;
}

export interface WebServerOptions {
    port?: number;
    /** 单页 HTML 的路径（测试可注入临时文件） */
    indexHtmlPath?: string;
    /** 是否要求先通过 /api/auth/login；生产 Web UI 默认开启。 */
    requireLogin?: boolean;
}

/**
 * 创建（但不启动）Web 服务。
 * @param agentFactory 用给定的 ConfirmFn、认证回调和运行时凭证构造会话 Agent
 */
export function createWebServer(
    agentFactory: (confirm: ConfirmFn, authHooks?: TwoFactorHooks, credentials?: LoginCredentials) => Agent,
    opts: WebServerOptions = {},
): Server {
    const port = opts.port ?? 3457;
    const requireLogin = opts.requireLogin ?? true;
    const indexPath = opts.indexHtmlPath ?? join(import.meta.dirname, "public", "index.html");
    const indexHtml = readFileSync(indexPath, "utf8");

    // 单用户会话：整个服务共享一个 Agent（多轮对话靠它的 messages 延续）
    let agent: Agent | undefined;
    let authenticated = false;
    /** 当前轮的确认桥（busy 互斥保证只有一轮在跑） */
    let currentConfirm: ConfirmFn = async () => false;
    const delegatingConfirm: ConfirmFn = (call, skill) => currentConfirm(call, skill);
    /** 进行中的确认请求（id → 应答器） */
    const pendingConfirms = new Map<string, PendingConfirm>();
    let confirmSeq = 0;
    let busy = false;
    let pendingAuth: PendingAuth | undefined;
    let authSeq = 0;
    let currentAuthHooks: TwoFactorHooks = {};
    const delegatingAuthHooks: TwoFactorHooks = {
        twoFactorMethodHook: (hasWeChatBool, phone, hasTotp) =>
            currentAuthHooks.twoFactorMethodHook?.(hasWeChatBool, phone, hasTotp) ?? Promise.resolve(undefined),
        twoFactorAuthHook: () => currentAuthHooks.twoFactorAuthHook?.() ?? Promise.resolve(undefined),
        onLoginSuccess: () => currentAuthHooks.onLoginSuccess?.(),
    };

    const closePendingAuth = (): void => {
        const pending = pendingAuth;
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingAuth = undefined;
        pending.resolve(undefined);
    };

    const createAuthHooks = (
        res: ServerResponse,
        markUsed: () => void,
        wasUsed: () => boolean,
        markSuccess?: () => void,
    ): TwoFactorHooks => ({
        twoFactorMethodHook: (hasWeChatBool, phone, hasTotp) => {
            markUsed();
            const methods: AuthMethod[] = [];
            if (hasTotp) methods.push("totp");
            if (phone) methods.push("mobile");
            if (hasWeChatBool) methods.push("wechat");
            return new Promise<AuthMethod | undefined>((resolve) => {
                const id = `auth_${++authSeq}`;
                const timer = setTimeout(() => {
                    if (pendingAuth?.id !== id) return;
                    pendingAuth = undefined;
                    sseSend(res, "auth", {phase: "error", message: "二次认证等待超时，请重新发起查询。"});
                    resolve(undefined);
                }, AUTH_TIMEOUT_MS);
                pendingAuth = {id, phase: "method", methods, resolve, timer};
                sseSend(res, "auth", {
                    phase: "method",
                    id,
                    methods,
                    phone: maskPhone(phone),
                });
            });
        },
        twoFactorAuthHook: () => {
            markUsed();
            return new Promise<string | undefined>((resolve) => {
                const id = `auth_${++authSeq}`;
                const timer = setTimeout(() => {
                    if (pendingAuth?.id !== id) return;
                    pendingAuth = undefined;
                    sseSend(res, "auth", {phase: "error", message: "验证码输入超时，请重新发起查询。"});
                    resolve(undefined);
                }, AUTH_TIMEOUT_MS);
                pendingAuth = {id, phase: "code", resolve, timer};
                sseSend(res, "auth", {phase: "code", id});
            });
        },
        onLoginSuccess: () => {
            if (wasUsed()) {
                markSuccess?.();
                sseSend(res, "auth", {phase: "success"});
            }
        },
    });

    const writeSseHeaders = (res: ServerResponse): void => {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
    };

    const handleAuthLogin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (busy) {
            res.writeHead(409).end("another operation is in flight");
            return;
        }
        let credentials: LoginCredentials;
        try {
            const parsed = JSON.parse(await readBody(req)) as {username?: unknown; password?: unknown};
            const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
            const password = typeof parsed.password === "string" ? parsed.password : "";
            if (!username || username.length > 128 || !password || password.length > 512) throw new Error();
            credentials = {
                username,
                password,
                fingerprint: process.env.THU_FINGERPRINT || randomUUID().replace(/-/g, ""),
            };
        } catch {
            res.writeHead(400).end("username and password required");
            return;
        }

        busy = true;
        writeSseHeaders(res);
        let authUsed = false;
        let authSuccessSent = false;
        const authHooks = createAuthHooks(
            res,
            () => { authUsed = true; },
            () => authUsed,
            () => { authSuccessSent = true; },
        );
        currentAuthHooks = authHooks;
        res.once("close", () => {
            if (currentAuthHooks === authHooks) closePendingAuth();
        });

        try {
            agent = agentFactory(delegatingConfirm, delegatingAuthHooks, credentials);
            await agent.login();
            authenticated = true;
            if (!authSuccessSent) sseSend(res, "auth", {phase: "success"});
            sseSend(res, "done", {});
        } catch (e) {
            authenticated = false;
            agent = undefined;
            sseSend(res, "auth", {phase: "error", message: (e as Error).message});
            sseSend(res, "done", {});
        } finally {
            if (pendingAuth) closePendingAuth();
            busy = false;
            currentAuthHooks = {};
            res.end();
        }
    };

    const handleAuthStatus = (res: ServerResponse): void => {
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({authenticated}));
    };

    const handleAuthLogout = (res: ServerResponse): void => {
        if (busy) {
            res.writeHead(409).end("another operation is in flight");
            return;
        }
        agent = undefined;
        authenticated = false;
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({authenticated: false}));
    };

    const handleChat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (busy) {
            res.writeHead(409).end("another question is in flight");
            return;
        }
        if (requireLogin && (!authenticated || !agent)) {
            res.writeHead(401).end("请先点击右上角“登录”并完成清华账号认证");
            return;
        }
        let question: string;
        let images: string[] | undefined;
        let rawBody: string;
        try {
            rawBody = await readBody(req);
        } catch {
            res.writeHead(413).end("request body too large");
            return;
        }
        try {
            const parsed = JSON.parse(rawBody) as {question?: unknown; images?: unknown};
            const imgErr = validateImages(parsed.images);
            if (imgErr) {
                res.writeHead(400).end(imgErr);
                return;
            }
            if (parsed.images && !config.llm.vision) {
                res.writeHead(400).end("当前模型端点不支持图片输入（LLM_VISION=0）");
                return;
            }
            images = parsed.images as string[] | undefined;
            if (typeof parsed.question !== "string") throw new Error();
            question = parsed.question.trim();
            if (!question && !images) throw new Error();
        } catch {
            res.writeHead(400).end("question required");
            return;
        }

        busy = true;
        writeSseHeaders(res);

        let authUsed = false;
        const authHooks = createAuthHooks(res, () => { authUsed = true; }, () => authUsed);
        currentAuthHooks = authHooks;
        res.once("close", () => {
            if (currentAuthHooks === authHooks) closePendingAuth();
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
            agent ??= agentFactory(delegatingConfirm, delegatingAuthHooks);
            const result = await agent.ask(question, {
                onToken: (text) => sseSend(res, "token", {text}),
                onToolEvent: (e) => sseSend(res, "tool", e),
                ...(images ? {images} : {}),
            });
            const authFailure = result.toolCalls
                .map((toolCall) => extractAuthFailure(toolCall.result))
                .find((message): message is string => Boolean(message));
            if (authFailure) sseSend(res, "auth", {phase: "error", message: authFailure});
            // 工具结果里有支付链接的，生成二维码推给前端；有支付表单的，推原始 HTML 让前端出"前往支付"按钮
            for (const t of result.toolCalls) {
                const payUrl = extractPayUrl(t.result);
                if (payUrl) {
                    const dataUrl = await makeQrDataUrl(payUrl);
                    sseSend(res, "qr", {url: payUrl, ...(dataUrl ? {dataUrl} : {})});
                }
                const payFormHtml = extractPayFormHtml(t.result);
                if (payFormHtml) {
                    sseSend(res, "payform", {html: payFormHtml});
                }
            }
            sseSend(res, "answer", {text: result.answer});
            sseSend(res, "done", {});
        } catch (e) {
            sseSend(res, "error", {message: (e as Error).message});
        } finally {
            if (pendingAuth) closePendingAuth();
            busy = false;
            currentConfirm = async () => false;
            currentAuthHooks = {};
            res.end();
        }
    };

    const handleAuthMethod = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        let parsed: {id?: string; method?: unknown};
        try {
            parsed = JSON.parse(await readBody(req));
        } catch {
            res.writeHead(400).end("bad json");
            return;
        }
        const pending = pendingAuth;
        const method = parsed.method;
        if (!pending || pending.phase !== "method" || pending.id !== parsed.id) {
            res.writeHead(404).end("auth request not found or expired");
            return;
        }
        if (method !== "totp" && method !== "mobile" && method !== "wechat") {
            res.writeHead(400).end("unsupported auth method");
            return;
        }
        if (!pending.methods.includes(method)) {
            res.writeHead(400).end("auth method unavailable");
            return;
        }
        clearTimeout(pending.timer);
        pendingAuth = undefined;
        pending.resolve(method);
        res.writeHead(200, {"Content-Type": "application/json"}).end("{}");
    };

    const handleAuthCode = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        let parsed: {id?: string; code?: unknown};
        try {
            parsed = JSON.parse(await readBody(req));
        } catch {
            res.writeHead(400).end("bad json");
            return;
        }
        const pending = pendingAuth;
        const code = typeof parsed.code === "string" ? parsed.code.trim() : "";
        if (!pending || pending.phase !== "code" || pending.id !== parsed.id) {
            res.writeHead(404).end("auth request not found or expired");
            return;
        }
        if (!code || code.length > 128) {
            res.writeHead(400).end("invalid auth code");
            return;
        }
        clearTimeout(pending.timer);
        pendingAuth = undefined;
        pending.resolve(code);
        res.writeHead(200, {"Content-Type": "application/json"}).end("{}");
    };

    const handleAuthCancel = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        let parsed: {id?: string};
        try {
            parsed = JSON.parse(await readBody(req));
        } catch {
            res.writeHead(400).end("bad json");
            return;
        }
        const pending = pendingAuth;
        if (!pending || pending.id !== parsed.id) {
            res.writeHead(404).end("auth request not found or expired");
            return;
        }
        closePendingAuth();
        res.writeHead(200, {"Content-Type": "application/json"}).end("{}");
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
            if (req.method === "GET" && url.pathname === "/api/capabilities") {
                res.writeHead(200, {"Content-Type": "application/json"});
                res.end(JSON.stringify({vision: config.llm.vision}));
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/auth/status") return handleAuthStatus(res);
            if (req.method === "POST" && url.pathname === "/api/auth/login") return handleAuthLogin(req, res);
            if (req.method === "POST" && url.pathname === "/api/auth/logout") return handleAuthLogout(res);
            if (req.method === "POST" && url.pathname === "/api/chat") return handleChat(req, res);
            if (req.method === "POST" && url.pathname === "/api/confirm") return handleConfirm(req, res);
            if (req.method === "POST" && url.pathname === "/api/auth/method") return handleAuthMethod(req, res);
            if (req.method === "POST" && url.pathname === "/api/auth/code") return handleAuthCode(req, res);
            if (req.method === "POST" && url.pathname === "/api/auth/cancel") return handleAuthCancel(req, res);
            res.writeHead(404).end("not found");
        })().catch((e) => {
            if (!res.headersSent) res.writeHead(500);
            res.end(String(e));
        });
    });
}
