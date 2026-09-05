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

/** 与 lib 同款 UA（usereg 对非浏览器 UA 可能区别对待） */
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36";

export class UseregClient {
    /** 独立 cookie jar：name → value（usereg 站点单域，无需按域分桶） */
    private readonly jar = new Map<string, string>();
    private loggedIn = false;
    private readonly base: string;

    constructor(
        private readonly solver: NetworkCodeSolver | undefined,
        private readonly password?: string,
        opts: {
            baseUrl?: string;
            onDebug?: (info: string) => void;
            /** 校园网登录名是邮箱前缀（emailName），通常 ≠ 学号；由装配层在登录时解析 */
            resolveUsername?: () => Promise<string>;
            /** 也可以直接给固定用户名（测试用） */
            username?: string;
        } = {},
    ) {
        this.base = (opts.baseUrl ?? process.env.USEREG_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
        this.onDebug = opts.onDebug;
        this.resolveUsername = opts.resolveUsername;
        this.username = opts.username;
    }

    private readonly onDebug?: (info: string) => void;
    private readonly resolveUsername?: () => Promise<string>;
    private username?: string;

    /** 诊断输出（不打印凭证；脚本排障用） */
    private debug(info: string): void {
        this.onDebug?.(info);
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
        if (!this.username) {
            if (!this.resolveUsername) {
                throw new UseregAuthError("缺少校园网登录名（info 邮箱前缀），且未提供解析方式。");
            }
            this.username = await this.resolveUsername();
        }
        if (!this.password) {
            throw new UseregAuthError("缺少校园网密码（与 Info 密码相同）。请先登录或配置 .env。");
        }
        // 识别失败换新验证码重试（超级鹰约半数误差率的既有消化经验）。
        // 每次尝试都重取登录页：服务端会在验证码请求途中轮换 _csrf-8800 cookie，
        // 旧页面里的表单 token 会与轮换后的 cookie 失配（实测 POST /login 400）
        let lastMessage = "验证码识别失败";
        for (let attempt = 1; attempt <= 3; attempt++) {
            const loginHtml = await this.jarFetch("/login");
            if (!loginHtml.includes("loginform-verifycode")) {
                // 无验证码表单 = 已有会话（与 lib ensureNetworkLoggedIn 同判据）
                this.loggedIn = true;
                return;
            }
            const csrfMeta = /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/.exec(loginHtml)?.[1];
            const publicKeyRaw = /id="public"[^>]*value="([^"]+)"/.exec(loginHtml)?.[1]
                ?? /value="([^"]+)"[^>]*id="public"/.exec(loginHtml)?.[1];
            const formCsrf = extractInputValue(loginHtml, "_csrf-8800");
            this.debug(`第 ${attempt} 次尝试：登录页 ${loginHtml.length} 字节，csrf/公钥/表单csrf=${[csrfMeta, publicKeyRaw, formCsrf].map((v) => Boolean(v)).join("/")}`);
            if (!csrfMeta || !publicKeyRaw || !formCsrf) {
                throw new UseregAuthError("校园网登录页解析失败（缺少 CSRF/公钥），页面结构可能已变更。");
            }
            await this.jarFetch("/site/captcha?refresh=1");
            const captchaImage = await this.jarRequest(`/site/captcha?_=${Date.now()}`);
            let code: string;
            try {
                code = await this.solver(captchaImage.toString("base64"));
                this.debug(`第 ${attempt} 次尝试：验证码图 ${captchaImage.length} 字节，识别结果 ${code.length} 字符`);
            } catch (e) {
                lastMessage = `验证码识别服务失败：${(e as Error).message}`;
                continue;
            }
            const encrypted = this.encryptPassword(publicKeyRaw, this.password);
            // validate-user 走 CSRF 校验（须带 cookie + X-CSRF-Token 头）。
            // lib 里"裸 fetch"在 RN 环境由系统自动带 cookie，Node 直连必须显式带上
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
            this.debug(`第 ${attempt} 次尝试 validate 响应：${validate.slice(0, 200)}`);
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
            // 登录表单是 AJAX 提交（按钮 type="button"）：必须带 X-Requested-With
            // 与 X-CSRF-Token 头（与浏览器 jQuery 行为一致），否则服务端 400
            await this.jarFetch("/login", {
                method: "POST",
                form: {
                    "_csrf-8800": formCsrf,
                    "LoginForm[username]": this.username,
                    "LoginForm[password]": encrypted,
                    "LoginForm[smsCode]": "",
                    "LoginForm[verifyCode]": code,
                },
                headers: {
                    "X-CSRF-Token": csrfMeta,
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": `${this.base}/login`,
                },
            });
            // 确认登录真的建立：登录页不再出现验证码字段才算成功
            const after = await this.jarFetch("/login");
            const stillLoggedOut = after.includes("loginform-verifycode");
            this.debug(`登录表单提交后仍含验证码字段=${stillLoggedOut}`);
            if (stillLoggedOut) {
                lastMessage = "登录表单未被接受（验证码可能错误），会话未建立";
                continue;
            }
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
                "User-Agent": BROWSER_UA,
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
                if (!location) {
                    // 无 Location 的 302（实测登录表单提交的响应如此）：
                    // 交给调用方随后的登录态检查兜底，不当作错误
                    this.debug(`302 响应无 Location，头：${[...resp.headers.entries()].map(([k, v]) => `${k}=${v.slice(0, 60)}`).join(" | ")}`);
                    return Buffer.alloc(0);
                }
                current = new URL(location, current).toString();
                continue;
            }
            const buffer = Buffer.from(await resp.arrayBuffer());
            if (resp.status !== 200 && resp.status !== 201) {
                const text = buffer.toString("utf8");
                const detail = /<h1>([\s\S]*?)<\/h1>/.exec(text)?.[1]
                    ?? /(?:Bad Request|#\d{3}|无法[^<]{0,40})/.exec(text)?.[0]
                    ?? "";
                throw new UseregAuthError(`校园网服务响应异常（HTTP ${resp.status}：${path}）${detail ? `：${detail.replace(/\s+/g, " ").trim().slice(0, 120)}` : ""}`);
            }
            return buffer;
        }
        throw new UseregAuthError(`校园网请求重定向超过 ${MAX_REDIRECTS} 次，已中止。`);
    }

    /** 无状态 POST（不带 cookie jar），复刻 lib 对 validate-user 的调用方式 */
    private async barePostForm(path: string, form: Record<string, string>, headers: Record<string, string>): Promise<string> {
        const resp = await fetch(`${this.base}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": BROWSER_UA,
                ...headers,
            },
            body: new URLSearchParams(form).toString(),
            redirect: "manual",
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return await resp.text();
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
