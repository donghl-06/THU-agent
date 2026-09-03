/**
 * UseregClient —— 校园网自助服务（usereg.tsinghua.edu.cn）客户端。Step 22b。
 *
 * 为什么不用 lib 通道（lib 有 getNetworkBalance/getOnlineDevices）：
 *   - lib 的 uFetch 用模块级全局 cookie jar（不分域名）。usereg 是 ASP.NET 站点，
 *     登录后同名 Session cookie 会顶掉 m.myhome 等其他系统的会话（Step 15 电费
 *     技能踩过的同款坑），所以要完全独立实现；
 *   - lib 的 usereg 入口走 webvpn 前缀；本客户端默认直连 usereg（校园网内可达，
 *     单用户本机场景为主），域名可用 env USEREG_BASE_URL 覆盖。
 *
 * 登录链路（与 lib network.ts 同源逆向）：
 *   GET /login → csrf-token(meta) + RSA 公钥(#public) + _csrf-8800(input)
 *   → GET /site/captcha?refresh=1（会话绑定验证码）→ GET /site/captcha?_=ts 得图
 *   → solver 识别 → POST /site/validate-user（X-CSRF-Token 头，JSON 应答）
 *   → POST /login 表单（_csrf-8800 + RSA 密文密码 + 验证码）
 *
 * 已登录判断沿用 lib：/login 页含 "loginform-verifycode" 即未登录。
 */
import {publicEncrypt, createPublicKey, constants} from "node:crypto";
import {config} from "../config/env";

const TIMEOUT_MS = 30_000;
/** 登录/查询链路的重定向上限（webvpn 场景跳数更多，直连一般 0 跳） */
const MAX_REDIRECTS = 10;

/** 字符验证码识别器：图（base64）→ 文本。由装配层注入（超级鹰等） */
export type NetworkCodeSolver = (imageBase64: string) => Promise<string>;

export interface NetworkBalance {
    productName: string;
    usedBytes: string;
    usedSeconds: string;
    accountBalance: string;
    settlementDate: string;
}

export interface NetworkDevice {
    ip4: string;
    ip6: string;
    loggedAt: string;
    authPermission: string;
    mac: string;
}

export class UseregAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UseregAuthError";
    }
}

/** 默认直连 usereg；校外场景可用 USEREG_BASE_URL 指到 webvpn 反代前缀 */
const DEFAULT_BASE = "https://usereg.tsinghua.edu.cn";

export class UseregClient {
    /** 独立 cookie jar：name → value（usereg 站点单域，无需按域分桶） */
    private readonly jar = new Map<string, string>();
    private loggedIn = false;
    private readonly base: string;

    constructor(
        private readonly solver: NetworkCodeSolver | undefined,
        private readonly username?: string,
        private readonly password?: string,
        baseUrl?: string,
    ) {
        this.base = (baseUrl ?? process.env.USEREG_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
    }

    /** 校园网余额 + 在线设备。未登录时自动走验证码登录流 */
    async getStatus(): Promise<{balance: NetworkBalance; devices: NetworkDevice[]}> {
        if (!this.loggedIn) {
            await this.login();
        }
        const home = await this.jarFetch("/home");
        return {balance: this.parseBalance(home), devices: this.parseDevices(home)};
    }

    // ---------- 登录 ----------

    private async login(): Promise<void> {
        if (!this.solver) {
            throw new UseregAuthError(
                "查询校园网需要识别图形验证码，请在 .env 配置超级鹰打码平台（CJY_USER/CJY_PASSWORD/CJY_SOFT_ID）。",
            );
        }
        if (!this.username || !this.password) {
            throw new UseregAuthError("缺少校园网账号（info 学号密码）。请先登录或配置 .env。");
        }
        const loginHtml = await this.jarFetch("/login");
        if (loginHtml.includes("webvpn")) {
            throw new UseregAuthError("当前经 webvpn 访问但 webvpn 会话未建立，请先登录后重试。");
        }
        if (!loginHtml.includes("loginform-verifycode")) {
            // 无验证码表单 = 已有会话（与 lib ensureNetworkLoggedIn 同判据）
            this.loggedIn = true;
            return;
        }
        const csrfMeta = /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/.exec(loginHtml)?.[1];
        const publicKeyRaw = /id="public"[^>]*value="([^"]+)"/.exec(loginHtml)?.[1]
            ?? /value="([^"]+)"[^>]*id="public"/.exec(loginHtml)?.[1];
        const formCsrf = extractInputValue(loginHtml, "_csrf-8800");
        if (!csrfMeta || !publicKeyRaw || !formCsrf) {
            throw new UseregAuthError("校园网登录页解析失败（缺少 CSRF/公钥），页面结构可能已变更。");
        }

        // 识别失败换新验证码重试（超级鹰约半数误差率的既有消化经验）
        let lastMessage = "验证码识别失败";
        for (let attempt = 1; attempt <= 3; attempt++) {
            await this.jarFetch("/site/captcha?refresh=1");
            const captchaImage = await this.jarRequest(`/site/captcha?_=${Date.now()}`);
            let code: string;
            try {
                code = await this.solver(captchaImage.toString("base64"));
            } catch (e) {
                lastMessage = `验证码识别服务失败：${(e as Error).message}`;
                continue;
            }
            const encrypted = this.encryptPassword(publicKeyRaw, this.password);
            const validate = await this.jarFetch("/site/validate-user", {
                method: "POST",
                form: {
                    "LoginForm[username]": this.username,
                    "LoginForm[password]": encrypted,
                    "LoginForm[verifyCode]": code,
                },
                headers: {
                    "X-CSRF-Token": csrfMeta,
                    "X-Requested-With": "XMLHttpRequest",
                },
            });
            let parsed: {success?: boolean; message?: string};
            try {
                parsed = JSON.parse(validate) as {success?: boolean; message?: string};
            } catch {
                parsed = {success: false, message: "validate-user 返回非 JSON"};
            }
            if (parsed.success !== true) {
                lastMessage = parsed.message ?? "验证码或账号被校园网系统拒绝";
                continue;
            }
            await this.jarFetch("/login", {
                method: "POST",
                form: {
                    "_csrf-8800": formCsrf,
                    "LoginForm[username]": this.username,
                    "LoginForm[password]": encrypted,
                    "LoginForm[smsCode]": "",
                    "LoginForm[verifyCode]": code,
                },
            });
            this.loggedIn = true;
            return;
        }
        throw new UseregAuthError(`校园网登录失败（已重试 3 次）：${lastMessage}。${config.chaojiying.configured ? "" : "注意：需在 .env 配置超级鹰（CJY_*）才能识别验证码。"}`);
    }

    /** RSA/PKCS1 加密密码（与页面 JSEncrypt 行为一致）。兼容裸 base64 与完整 PEM */
    private encryptPassword(publicKeyRaw: string, password: string): string {
        const cleaned = publicKeyRaw.replace(/\\n/g, "\n").trim();
        const pem = cleaned.includes("BEGIN")
            ? cleaned
            : `-----BEGIN PUBLIC KEY-----\n${cleaned}\n-----END PUBLIC KEY-----`;
        const key = createPublicKey(pem);
        return publicEncrypt({key, padding: constants.RSA_PKCS1_PADDING}, Buffer.from(password)).toString("base64");
    }

    // ---------- 页面解析（无 cheerio 依赖，正则/文本处理） ----------

    private parseBalance(homeHtml: string): NetworkBalance {
        const cells = tableRowCells(homeHtml, "w3-container");
        if (cells.length < 5) {
            throw new UseregAuthError("校园网首页未找到余额信息（可能未登录或页面结构变更）。");
        }
        return {
            productName: cells[0],
            usedBytes: cells[1],
            usedSeconds: cells[2],
            accountBalance: cells[3],
            settlementDate: cells[4],
        };
    }

    private parseDevices(homeHtml: string): NetworkDevice[] {
        return tableRows(homeHtml, "w1-container").map(({cells}) => ({
            ip4: cells[0] ?? "",
            ip6: cells[1] ?? "",
            loggedAt: cells[2] ?? "",
            authPermission: cells[3] ?? "",
            mac: cells[4] ?? "",
        }));
    }

    // ---------- 带 cookie jar 的 HTTP（手动 follow 重定向，逐跳收 Set-Cookie） ----------

    private async jarFetch(
        path: string,
        opts: {method?: string; form?: Record<string, string>; headers?: Record<string, string>} = {},
    ): Promise<string> {
        const buffer = await this.jarRequest(path, opts);
        return buffer.toString("utf8");
    }

    private async jarRequest(
        path: string,
        opts: {method?: string; form?: Record<string, string>; headers?: Record<string, string>} = {},
    ): Promise<Buffer> {
        const url = `${this.base}${path}`;
        let current = url;
        for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
            const headers: Record<string, string> = {
                Cookie: [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
                ...opts.headers,
            };
            let body: string | undefined;
            if (opts.form) {
                body = new URLSearchParams(opts.form).toString();
                headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
            }
            const resp = await fetch(current, {
                method: opts.method ?? (body !== undefined ? "POST" : "GET"),
                headers,
                body,
                redirect: "manual",
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            this.updateJar(resp);
            if ([301, 302, 303, 307, 308].includes(resp.status)) {
                const location = resp.headers.get("location");
                if (!location) throw new UseregAuthError(`校园网服务返回 ${resp.status} 但没有重定向目标。`);
                current = new URL(location, current).toString();
                continue;
            }
            const buffer = Buffer.from(await resp.arrayBuffer());
            if (resp.status !== 200 && resp.status !== 201) {
                throw new UseregAuthError(`校园网服务响应异常（HTTP ${resp.status}：${path}）。`);
            }
            return buffer;
        }
        throw new UseregAuthError(`校园网请求重定向超过 ${MAX_REDIRECTS} 次，已中止。`);
    }

    private updateJar(resp: Response): void {
        const setCookies = resp.headers.getSetCookie?.() ?? [];
        for (const line of setCookies) {
            const [pair] = line.split(";");
            const eq = pair.indexOf("=");
            if (eq <= 0) continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (value === "" || /expires=Thu,\s*01\s+Jan\s+1970/i.test(line)) {
                this.jar.delete(name);
            } else {
                this.jar.set(name, value);
            }
        }
    }
}

/** 从 HTML 提取 `<input name="X" value="Y">` 的 value（属性顺序两种都处理） */
function extractInputValue(html: string, name: string): string | undefined {
    const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0]
        ?? new RegExp(`<input[^>]*name='${name}'[^>]*>`).exec(html)?.[0];
    if (!tag) return undefined;
    return /value="([^"]*)"/.exec(tag)?.[1] ?? /value='([^']*)'/.exec(tag)?.[1];
}

/** 提取页面中某容器 id 下表格所有行的单元格文本与行属性（data-key 等） */
function tableRows(html: string, containerId: string): {attrs: Record<string, string>; cells: string[]}[] {
    const containerStart = html.indexOf(`id="${containerId}"`);
    if (containerStart === -1) return [];
    const nextContainer = html.indexOf('class="grid-view"', containerStart + 1);
    const section = html.slice(containerStart, nextContainer > containerStart ? nextContainer : undefined);
    const rows: {attrs: Record<string, string>; cells: string[]}[] = [];
    const trRe = /<tr([^>]*)>([\s\S]*?)<\/tr>/g;
    let match: RegExpExecArray | null;
    while ((match = trRe.exec(section)) !== null) {
        const attrs: Record<string, string> = {};
        const keyMatch = /data-key="([^"]*)"/.exec(match[1]);
        if (keyMatch) attrs.key = keyMatch[1];
        const cells: string[] = [];
        const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
        let td: RegExpExecArray | null;
        while ((td = tdRe.exec(match[2])) !== null) {
            cells.push(td[1].replace(/<[^>]*>/g, "").trim());
        }
        if (cells.length > 0) rows.push({attrs, cells});
    }
    return rows;
}

function tableRowCells(html: string, containerId: string): string[] {
    return tableRows(html, containerId)[0]?.cells ?? [];
}
