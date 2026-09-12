/**
 * 网络学堂带登录态的文件下载会话。
 *
 * thu-learn-lib（npm 4.x）的 cookie jar 是闭包私有的，结构化接口（通知/作业/提交）
 * 都走 Learn2018Helper，但「把课件真正下载到本地」需要一个我们能控制的会话。
 * 这里实现一个最小 SSO 登录 + cookie 会话，只服务文件下载：
 *   id.tsinghua.edu.cn 登录（SM2 加密密码）→ 拿 ticket → roam 到 learn → 带 cookie 下载
 *
 * 流程与 thu-learn-lib 的登录一致（MIT, https://github.com/Harry-Chen/thu-learn-lib）。
 * 会话是懒创建的：第一次下载时才登录；失效（被重定向回登录页）时自动重登一次。
 */
import {sm2} from "sm-crypto";
import {normalizeLearnError} from "./errors";

const ID_PREFIX = "https://id.tsinghua.edu.cn";
const ID_LOGIN = `${ID_PREFIX}/do/off/ui/auth/login/form/bb5df85216504820be7bba2b0ae1535b/0`;
const ID_LOGIN_CHECK = `${ID_PREFIX}/do/off/ui/auth/login/check`;
const LEARN_PREFIX = "https://learn.tsinghua.edu.cn";
const LEARN_AUTH_ROAM = (ticket: string) =>
    `${LEARN_PREFIX}/b/j_spring_security_thauth_roaming_entry?ticket=${ticket}`;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface LearnCredentials {
    username: string;
    password: string;
    /** 32 位 hex 稳定设备指纹（与 ThuClient 同一指纹，复用已信任设备） */
    fingerprint: string;
}

export interface DownloadedFile {
    /** 响应体 */
    buffer: Buffer;
    /** 服务端 Content-Disposition 给的文件名（可能为空） */
    filename?: string;
    contentType: string;
}

/** 下载会话登录失败时抛这个，让上层归一化 */
export class DownloadLoginError extends Error {}

export class LearnDownloadSession {
    /** hostname → {cookieName: value}（与 thu-learn-lib 的 jar 结构相同） */
    private readonly jar: Record<string, Record<string, string>> = {};
    private loggedIn = false;
    private loginInflight?: Promise<void>;

    constructor(private readonly credentials: LearnCredentials) {}

    /** cookie 感知的 fetch：自动带 jar、手动跟随重定向并跨域收集 Set-Cookie */
    private readonly sessionFetch = async (
        input: string | URL,
        init: RequestInit = {},
    ): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input.href);
        const cookie = Object.entries(this.jar[url.hostname] ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
        const headers = new Headers(init.headers);
        if (cookie) headers.set("cookie", cookie);
        const resp = await fetch(url, {...init, redirect: "manual", headers});
        for (const setCookie of resp.headers.getSetCookie()) {
            const [nameValue] = setCookie.split(";");
            const eq = nameValue.indexOf("=");
            if (eq <= 0) continue;
            const name = nameValue.slice(0, eq).trim();
            const value = nameValue.slice(eq + 1).trim();
            (this.jar[url.hostname] ??= {})[name] = value;
        }
        if (REDIRECT_STATUS.has(resp.status)) {
            const location = resp.headers.get("location");
            if (location) {
                const next = new URL(location, url).toString();
                const downgrade =
                    resp.status === 303 ||
                    ((resp.status === 301 || resp.status === 302) && (init.method ?? "GET") !== "GET");
                return this.sessionFetch(next, {
                    ...init,
                    method: downgrade ? "GET" : (init.method ?? "GET"),
                    body: downgrade ? undefined : init.body,
                });
            }
        }
        return resp;
    };

    /** 幂等且并发安全的登录（多文件同时下载共享一次 SSO） */
    private login(): Promise<void> {
        if (this.loggedIn) return Promise.resolve();
        this.loginInflight ??= this.doLogin()
            .then(() => {
                this.loggedIn = true;
            })
            .finally(() => {
                this.loginInflight = undefined;
            });
        return this.loginInflight;
    }

    private async doLogin(): Promise<void> {
        const {username, password, fingerprint} = this.credentials;
        const loginHtml = await (await this.sessionFetch(ID_LOGIN)).text();
        if (loginHtml.includes(`$("#c_code").removeClass('hidden');`)) {
            throw new DownloadLoginError("网络学堂下载会话登录触发验证码，请稍后再试。");
        }
        const sm2publicKey = /id="sm2publicKey"[^>]*>([^<]+)</.exec(loginHtml)?.[1]?.trim();
        if (!sm2publicKey) {
            throw new DownloadLoginError("无法解析统一认证登录页（sm2publicKey 缺失）。");
        }
        const form = new FormData();
        form.append("i_user", username);
        form.append("i_pass", `04${sm2.doEncrypt(password, sm2publicKey)}`);
        form.append("singleLogin", "on");
        form.append("fingerPrint", fingerprint);
        form.append("fingerGenPrint", "");
        form.append("fingerGenPrint3", "");
        form.append("i_captcha", "");
        const resp = await this.sessionFetch(ID_LOGIN_CHECK, {method: "POST", body: form});
        const html = await resp.text();
        if (html.includes("二次认证")) {
            throw new DownloadLoginError(
                "账号开启了二次认证且本设备未信任。请先在清灵里完成一次登录，再重试。",
            );
        }
        const redirectUrl = /<a[^>]+href="([^"]+)"/.exec(html)?.[1];
        const ticket = redirectUrl?.split("=").slice(-1)[0];
        if (!ticket) {
            throw new DownloadLoginError("统一认证未返回 ticket（账号密码可能错误）。");
        }
        const roam = await this.sessionFetch(LEARN_AUTH_ROAM(ticket));
        if (!roam.ok) {
            throw new DownloadLoginError(`roam 到网络学堂失败（HTTP ${roam.status}）。`);
        }
    }

    /**
     * 下载网络学堂的文件（需要登录态的 downloadUrl）。
     * 响应是 HTML 说明会话失效（被弹回登录页），自动重登一次再试。
     */
    async download(url: string): Promise<DownloadedFile> {
        await this.login();
        let resp = await this.sessionFetch(url);
        if (this.looksLikeLoginPage(resp)) {
            this.loggedIn = false;
            await this.login();
            resp = await this.sessionFetch(url);
        }
        const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
        if (!resp.ok || this.looksLikeLoginPage(resp)) {
            throw new DownloadLoginError(`下载失败（HTTP ${resp.status}），会话可能已失效。`);
        }
        const disposition = resp.headers.get("content-disposition") ?? "";
        const filename =
            /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ??
            /filename="?([^";]+)"?/i.exec(disposition)?.[1];
        const buffer = Buffer.from(await resp.arrayBuffer());
        return {buffer, filename: filename ? decodeURIComponent(filename) : undefined, contentType};
    }

    /** 弹回登录页的特征：HTML 页面（正常下载是文件流） */
    private looksLikeLoginPage(resp: Response): boolean {
        const type = resp.headers.get("content-type") ?? "";
        return type.includes("text/html") || resp.url.includes("login_timeout");
    }
}

/** 统一错误出口：与 LearnClient 相同的归一化 */
export function normalizeDownloadError(e: unknown) {
    return normalizeLearnError(e);
}
