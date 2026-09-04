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
 *   POST /api/ui/auth   → {token} → 正确则种 ui_token cookie（.env 配 UI_TOKEN 才启用鉴权；
 *                          启用时豁免清单之外的所有请求都需携带该 cookie，否则 403）
 *   POST /api/chat      → {question, sessionId?, images?} → SSE 流，事件：
 *       （sessionId 标识前端会话，缺省/非法落到 "default"；每个会话一个
 *         Agent 各自延续上下文，但共享同一登录态——见 agentFactory 实现）
 *       （images 为 data URL 数组，最多 4 张、每张 base64 不超过 6MB 字符；
 *         仅当端点支持 vision 时可用，见 config.llm.vision）
 *       token   {text}                    回答的流式片段
 *       tool    {phase,name,ms?,success?} 工具进度（start/end）
 *       confirm {id,name,args}            写操作待确认（前端弹窗）
 *       auth    {phase,...}                二次认证交互（前端弹窗）
 *       qr      {url, dataUrl?}           支付二维码（data URL 图片）
 *       payform {html}                    自动提交的支付表单（前端渲染"前往支付"按钮，新窗口提交到学校支付平台）
 *       calendar {title,filename,icsContent} 预约成功的日历卡片（前端渲染"下载日历"按钮）
 *       answer  {text}                    最终完整回答（前端校对用）
 *       usage   {promptTokens,completionTokens,totalTokens,costYuan?} 本轮 token 用量（costYuan 仅在 .env 配了 LLM_PRICE_* 时出现）
 *       done    {}                        本轮结束
 *       error   {message}                 出错
 *   POST /api/chat/cancel → 中止当前问答并等待服务端完成清理
 *   POST /api/session/destroy → {sessionId} 或 {all:true} 销毁后端会话上下文
 *   GET  /api/notifications → {notifications} 任务执行通知（drain 即消费，前端 30s 轮询）
 *   GET  /api/tasks         → {tasks} 定时任务列表
 *   POST /api/tasks/cancel  → {id} 取消定时任务
 *   POST /api/session/title → {sessionId} → {title|null} 概括式会话标题（每会话只生成一次）
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
import type {LlmClient} from "../harness/llmClient";
import {createLlmClient} from "../harness/llmClient";
import type {ConfirmFn} from "../harness/toolRegistry";
import type {TokenUsage} from "../harness/types";
import {config} from "../config/env";
import {SessionStore} from "./sessionStore";
import {NotificationHub} from "./notificationHub";
import {extractCalendarEvent} from "./calendar";
import {generateTitle} from "./titleGen";
import {taskSessionContext} from "../tasks/sessionContext";
import type {TaskScheduler} from "../tasks/scheduler";
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

/** 按 .env 单价（元/百万 token）估算本轮费用；单价没配齐就不显示费用 */
function estimateCostYuan(usage: TokenUsage): number | undefined {
    const pin = config.llm.priceIn;
    const pout = config.llm.priceOut;
    if (pin === undefined || pout === undefined) return undefined;
    return (usage.promptTokens * pin + usage.completionTokens * pout) / 1_000_000;
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
    /**
     * 会话持久化文件路径（Step 21c）。提供时：会话 messages 落盘、
     * 重启恢复；不提供则纯内存（测试默认不落盘）。
     */
    sessionStorePath?: string;
    /** 任务调度器（Step 23）。提供时暴露 /api/tasks 查询与取消端点 */
    scheduler?: TaskScheduler;
    /** 通知中心（Step 23）。提供时暴露 /api/notifications 轮询端点 */
    notificationHub?: NotificationHub;
    /** 会话标题生成的 LLM（测试注入假实例）；缺省时首次使用才懒创建真实客户端 */
    titleLlm?: LlmClient;
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
    const indexPath = opts.indexHtmlPath ?? join(process.cwd(), "src", "server", "public", "index.html");
    const indexHtml = readFileSync(indexPath, "utf8");
    const store = opts.sessionStorePath ? new SessionStore(opts.sessionStorePath) : undefined;
    const scheduler = opts.scheduler;
    const hub = opts.notificationHub;
    /** 标题生成的 LLM：懒创建（未配 LLM_API_KEY 的环境只要不触发就不报错） */
    let titleLlmClient: LlmClient | undefined;
    /** 已生成过概括式标题的会话（每会话只烧一次轻量调用） */
    const titledSessions = new Set<string>();

    // ===== Web UI 访问口令（.env 配 UI_TOKEN 才启用；局域网开放时防同网他人使用）=====
    // 豁免清单：首页（要加载页面才能输口令）、capabilities（启动器/打包冒烟的探活端点，
    // 只暴露 vision 布尔值）、manifest 与图标（无敏感）。其余一律 403。
    const uiAuthEnabled = (): boolean => config.ui.token.length > 0;
    const cookieOf = (req: IncomingMessage, name: string): string | undefined => {
        const header = req.headers.cookie;
        if (!header) return undefined;
        for (const pair of header.split(";")) {
            const eq = pair.indexOf("=");
            if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
        }
        return undefined;
    };
    const uiAuthorized = (req: IncomingMessage): boolean => {
        if (!uiAuthEnabled()) return true;
        return cookieOf(req, "ui_token") === config.ui.token;
    };
    const handleUiAuth = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!uiAuthEnabled()) {
            res.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({enabled: false}));
            return;
        }
        let parsed: {token?: unknown};
        try {
            parsed = JSON.parse(await readBody(req)) as {token?: unknown};
        } catch {
            res.writeHead(400).end("bad json");
            return;
        }
        if (parsed.token !== config.ui.token) {
            res.writeHead(403, {"Content-Type": "application/json"}).end(JSON.stringify({ok: false}));
            return;
        }
        // 口令种成持久 cookie：前端输一次即可，浏览器对所有请求自动携带（SameSite 防 CSRF）
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `ui_token=${config.ui.token}; Path=/; Max-Age=31536000; SameSite=Strict`,
        }).end(JSON.stringify({ok: true}));
    };

    // 多会话：前端每个会话一个 Agent（各自 messages 延续上下文，互不串味）。
    // 登录态仍全局共享——agentFactory 侧复用同一 ThuClient，登录一次全会话可用。
    const agents = new Map<string, Agent>();
    /** 缺省/非法 sessionId 的落点（兼容不带 sessionId 的调用方与旧测试） */
    const DEFAULT_SESSION = "default";
    /** 会话 Agent 上限（LRU 淘汰最久未用的，防长驻进程泄漏） */
    const MAX_SESSION_AGENTS = 50;
    let authenticated = false;
    /** 当前轮的确认桥（busy 互斥保证只有一轮在跑） */
    let currentConfirm: ConfirmFn = async () => false;
    const delegatingConfirm: ConfirmFn = (call, skill) => currentConfirm(call, skill);
    /** 进行中的确认请求（id → 应答器） */
    const pendingConfirms = new Map<string, PendingConfirm>();
    let confirmSeq = 0;
    let busy = false;
    let activeChatAbort: AbortController | undefined;
    let activeChatDone: Promise<void> | undefined;
    let pendingAuth: PendingAuth | undefined;
    let authSeq = 0;
    let currentAuthHooks: TwoFactorHooks = {};
    const delegatingAuthHooks: TwoFactorHooks = {
        twoFactorMethodHook: (hasWeChatBool, phone, hasTotp) =>
            currentAuthHooks.twoFactorMethodHook?.(hasWeChatBool, phone, hasTotp) ?? Promise.resolve(undefined),
        twoFactorAuthHook: () => currentAuthHooks.twoFactorAuthHook?.() ?? Promise.resolve(undefined),
        onLoginSuccess: () => currentAuthHooks.onLoginSuccess?.(),
    };

    /** 前端会话 id 白名单字符（对齐 localStorage 侧生成的 s_xxx 格式）；非法一律落 default */
    const normalizeSessionId = (value: unknown): string =>
        typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : DEFAULT_SESSION;

    /** 取会话 Agent，没有就建（登录态由 factory 侧共享，无需重新登录；
     *  配了持久化时新 Agent 恢复该会话的历史——system 换用当前的新提示词） */
    const getOrCreateAgent = (sessionId: string): Agent => {
        const existing = agents.get(sessionId);
        if (existing) {
            // Map 迭代按插入序：重插一次即刷新 LRU 新鲜度
            agents.delete(sessionId);
            agents.set(sessionId, existing);
            return existing;
        }
        const created = agentFactory(delegatingConfirm, delegatingAuthHooks);
        const saved = store?.get(sessionId);
        if (saved?.length) {
            created.loadMessages([created.snapshotMessages()[0], ...saved]);
        }
        agents.set(sessionId, created);
        while (agents.size > MAX_SESSION_AGENTS) {
            const oldest = agents.keys().next().value;
            if (oldest === undefined || oldest === sessionId) break;
            agents.delete(oldest);
        }
        return created;
    };

    const closePendingAuth = (): void => {
        const pending = pendingAuth;
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingAuth = undefined;
        pending.resolve(undefined);
    };

    const closePendingConfirms = (): void => {
        for (const pending of pendingConfirms.values()) {
            clearTimeout(pending.timer);
            pending.resolve(false);
        }
        pendingConfirms.clear();
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
            const loginAgent = agentFactory(delegatingConfirm, delegatingAuthHooks, credentials);
            await loginAgent.login();
            authenticated = true;
            // 默认会话直接复用登录建的 Agent；其余会话按需新建（共享同一登录态）
            agents.set(DEFAULT_SESSION, loginAgent);
            if (!authSuccessSent) sseSend(res, "auth", {phase: "success"});
            sseSend(res, "done", {});
        } catch (e) {
            authenticated = false;
            agents.delete(DEFAULT_SESSION);
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
        agents.clear();
        authenticated = false;
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({authenticated: false}));
    };

    const handleChat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (busy && activeChatAbort?.signal.aborted && activeChatDone) {
            await activeChatDone;
        }
        if (busy) {
            res.writeHead(409).end("another question is in flight");
            return;
        }
        if (requireLogin && !authenticated) {
            res.writeHead(401).end("请先点击右上角“登录”并完成清华账号认证");
            return;
        }
        let question: string;
        let images: string[] | undefined;
        let sessionId: string;
        let rawBody: string;
        try {
            rawBody = await readBody(req);
        } catch {
            res.writeHead(413).end("request body too large");
            return;
        }
        try {
            const parsed = JSON.parse(rawBody) as {question?: unknown; images?: unknown; sessionId?: unknown};
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
            sessionId = normalizeSessionId(parsed.sessionId);
            if (typeof parsed.question !== "string") throw new Error();
            question = parsed.question.trim();
            if (!question && !images) throw new Error();
        } catch {
            res.writeHead(400).end("question required");
            return;
        }

        busy = true;
        writeSseHeaders(res);

        const chatAbort = new AbortController();
        let resolveChatDone!: () => void;
        const chatDone = new Promise<void>((resolve) => { resolveChatDone = resolve; });
        activeChatAbort = chatAbort;
        activeChatDone = chatDone;

        let authUsed = false;
        const authHooks = createAuthHooks(res, () => { authUsed = true; }, () => authUsed);
        currentAuthHooks = authHooks;
        // 客户端断开（用户点"停止生成"）→ 中止 LLM 请求，省掉后续 token
        res.once("close", () => {
            chatAbort.abort();
            if (activeChatAbort !== chatAbort) return;
            if (currentAuthHooks === authHooks) closePendingAuth();
            closePendingConfirms();
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

        let sessionAgent: Agent | undefined;
        try {
            sessionAgent = getOrCreateAgent(sessionId);
            // 任务类 skill 需要知道归属会话（通知回传定位）；经 AsyncLocalStorage 透传
            const result = await taskSessionContext.run(sessionId, () => sessionAgent!.ask(question, {
                onToken: (text) => sseSend(res, "token", {text}),
                onToolEvent: (e) => sseSend(res, "tool", e),
                ...(images ? {images} : {}),
                signal: chatAbort.signal,
            }));
            const authFailure = result.toolCalls
                .map((toolCall) => extractAuthFailure(toolCall.result))
                .find((message): message is string => Boolean(message));
            if (authFailure) sseSend(res, "auth", {phase: "error", message: authFailure});
            // 工具结果里有支付链接的，生成二维码推给前端；有支付表单的，推原始 HTML 让前端出"前往支付"按钮；
            // 预约成功的，推现成的 .ics 文本让前端出"加入日历"按钮
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
                const cal = extractCalendarEvent(t.name, t.result);
                if (cal) {
                    sseSend(res, "calendar", {title: cal.title, filename: cal.filename, icsContent: cal.icsContent});
                }
            }
            sseSend(res, "answer", {text: result.answer});
            if (result.usage) {
                const cost = estimateCostYuan(result.usage);
                sseSend(res, "usage", {...result.usage, ...(cost !== undefined ? {costYuan: cost} : {})});
            }
            sseSend(res, "done", {});
        } catch (e) {
            if (!chatAbort.signal.aborted) sseSend(res, "error", {message: (e as Error).message});
        } finally {
            if (pendingAuth) closePendingAuth();
            closePendingConfirms();
            busy = false;
            currentConfirm = async () => false;
            currentAuthHooks = {};
            if (activeChatAbort === chatAbort) {
                activeChatAbort = undefined;
                activeChatDone = undefined;
                resolveChatDone();
            }
            // 会话上下文落盘（ask 失败时已回滚到问前状态，落盘内容一致）
            if (store && sessionAgent) store.set(sessionId, sessionAgent.snapshotMessages());
            res.end();
        }
    };

    const handleChatCancel = async (res: ServerResponse): Promise<void> => {
        const controller = activeChatAbort;
        const done = activeChatDone;
        if (!controller || !done) {
            res.writeHead(200, {"Content-Type": "application/json"});
            res.end(JSON.stringify({cancelled: false}));
            return;
        }
        controller.abort();
        closePendingAuth();
        closePendingConfirms();
        await done;
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({cancelled: true}));
    };

    /** 销毁后端会话上下文：前端删会话/清空历史时调用，防止残留上下文复活 */
    const handleSessionDestroy = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        let parsed: {sessionId?: unknown; all?: unknown};
        try {
            parsed = JSON.parse(await readBody(req)) as {sessionId?: unknown; all?: unknown};
        } catch {
            res.writeHead(400).end("bad json");
            return;
        }
        if (parsed.all === true) {
            agents.clear();
            store?.clear();
        } else {
            const sid = normalizeSessionId(parsed.sessionId);
            agents.delete(sid);
            store?.delete(sid);
        }
        res.writeHead(200, {"Content-Type": "application/json"}).end("{}");
    };

    /** 任务执行通知：前端轮询取走（drain 即消费） */
    const handleNotifications = (res: ServerResponse): void => {
        if (requireLogin && !authenticated) {
            res.writeHead(401).end("not authenticated");
            return;
        }
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({notifications: hub ? hub.drain() : []}));
    };

    /** 定时任务列表（给前端展示/调试；对话内 list_my_tasks 也可查） */
    const handleTaskList = (res: ServerResponse): void => {
        if (requireLogin && !authenticated) {
            res.writeHead(401).end("not authenticated");
            return;
        }
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({tasks: scheduler ? scheduler.list() : []}));
    };

    /** 取消定时任务 */
    const handleTaskCancel = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!scheduler) {
            res.writeHead(404).end("scheduler unavailable");
            return;
        }
        let parsed: {id?: unknown};
        try {
            parsed = JSON.parse(await readBody(req)) as {id?: unknown};
        } catch {
            res.writeHead(400).end("bad json");
            return;
        }
        if (typeof parsed.id !== "string" || !parsed.id.trim()) {
            res.writeHead(400).end("id required");
            return;
        }
        const task = scheduler.cancel(parsed.id.trim());
        if (!task) {
            res.writeHead(404).end("task not found or already finished");
            return;
        }
        res.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({cancelled: task.id}));
    };

    /** 概括式会话标题：首轮回答后前端调用，每会话只生成一次 */
    const handleSessionTitle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (requireLogin && !authenticated) {
            res.writeHead(401).end("not authenticated");
            return;
        }
        let parsed: {sessionId?: unknown};
        try {
            parsed = JSON.parse(await readBody(req)) as {sessionId?: unknown};
        } catch {
            res.writeHead(400).end("bad json");
            return;
        }
        const sid = normalizeSessionId(parsed.sessionId);
        const agent = agents.get(sid);
        if (!agent || titledSessions.has(sid)) {
            res.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({title: null}));
            return;
        }
        titledSessions.add(sid);
        titleLlmClient ??= opts.titleLlm ?? createLlmClient();
        const title = await generateTitle(titleLlmClient, agent.snapshotMessages());
        res.writeHead(200, {"Content-Type": "application/json"}).end(JSON.stringify({title: title ?? null}));
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
            // UI 口令守卫：豁免清单之外的一切请求，未携带正确口令 cookie 时 403
            // （前端以 403 区别于清华未登录的 401，据此弹出"输入访问口令"遮罩）
            const uiAuthExempt =
                (req.method === "POST" && url.pathname === "/api/ui/auth") ||
                (req.method === "GET" && url.pathname === "/manifest.webmanifest") ||
                (req.method === "GET" && url.pathname.startsWith("/icons/"));
            if (!uiAuthExempt && !uiAuthorized(req)) {
                res.writeHead(403, {"Content-Type": "application/json"}).end(JSON.stringify({uiAuth: true}));
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/auth/status") return handleAuthStatus(res);
            if (req.method === "POST" && url.pathname === "/api/auth/login") return handleAuthLogin(req, res);
            if (req.method === "POST" && url.pathname === "/api/ui/auth") return handleUiAuth(req, res);
            if (req.method === "POST" && url.pathname === "/api/auth/logout") return handleAuthLogout(res);
            if (req.method === "POST" && url.pathname === "/api/chat/cancel") return handleChatCancel(res);
            if (req.method === "POST" && url.pathname === "/api/session/destroy") return handleSessionDestroy(req, res);
            if (req.method === "GET" && url.pathname === "/api/notifications") return handleNotifications(res);
            if (req.method === "GET" && url.pathname === "/api/tasks") return handleTaskList(res);
            if (req.method === "POST" && url.pathname === "/api/tasks/cancel") return handleTaskCancel(req, res);
            if (req.method === "POST" && url.pathname === "/api/session/title") return handleSessionTitle(req, res);
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
