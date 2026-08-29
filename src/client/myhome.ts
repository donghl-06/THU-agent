/**
 * MyhomeClient —— m.myhome.tsinghua.edu.cn（"我们的家园"微信版）的独立客户端。
 *
 * 为什么不走 @thu-info/lib：lib 只封装了桌面版 myhome 的电费页
 * （Netweb_Home_electricity_Detail.aspx，间歇性"暂时无法查询"）；
 * 用户实测微信版查询页一直稳定，且它接受 info 学号+密码直接表单登录
 * （2026-08-30 探针验证），不依赖 lib 的 webvpn 漫游。
 *
 * 为什么不用 lib 的 uFetch：uFetch 的 cookie jar 是不分域名的扁平 map，
 * m.myhome 的 ASP.NET_SessionId 会顶掉 webvpn 的同名 cookie，互相踩。
 * 所以这里用全局 fetch + 自己的 cookie jar，与 lib 完全隔离。
 * （全局 fetch 已被 src/utils/httpProxy.ts 接好代理。）
 *
 * 凭证只从 config（.env）读，与 ThuClient 同一套 info 账号。
 */
import {config} from "../config/env";
import {ThuError} from "./errors";

const BASE = "https://m.myhome.tsinghua.edu.cn/weixin";
const AUTH_URL = `${BASE}/weixin_user_authenticate.aspx?url=%2fweixin%2fweixin_student_electricity_search.aspx`;
const SEARCH_URL = `${BASE}/weixin_student_electricity_search.aspx`;

export interface MyhomeEleInfo {
    studentId: string;
    name: string;
    building: string;
    room: string;
    /** 剩余电量（度/kWh） */
    kwh: number;
    /** 抄表时间原文，如 "2026-8-30 0:04:18" */
    meterTime: string;
}

/** 从 span id 抓文本，如 ..._lblele">19.44</span> → "19.44" */
function grabSpan(html: string, spanId: string): string {
    const m = new RegExp(`id="${spanId}"[^>]*>([^<]*)</span>`).exec(html);
    return m?.[1]?.trim() ?? "";
}

export class MyhomeClient {
    /** 自己的 cookie jar（name → value），与 lib 的全局 jar 隔离 */
    private readonly jar = new Map<string, string>();
    private loggedIn = false;

    private cookieHeader(): string {
        return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }

    /** 手动处理重定向的 fetch：逐跳收 cookie，最多跟 5 跳 */
    private async req(url: string, post?: Record<string, string>): Promise<string> {
        let current = url;
        let body: string | undefined;
        if (post) {
            body = new URLSearchParams(post).toString();
        }
        for (let hop = 0; hop < 5; hop++) {
            const headers: Record<string, string> = {
                Cookie: this.cookieHeader(),
                "User-Agent": "Mozilla/5.0 (Linux; Android 10) THU-Agent",
            };
            if (body !== undefined) {
                headers["Content-Type"] = "application/x-www-form-urlencoded";
            }
            let resp: Response;
            try {
                resp = await fetch(current, {
                    method: body !== undefined ? "POST" : "GET",
                    headers,
                    body,
                    redirect: "manual",
                });
            } catch (e) {
                throw new ThuError("NETWORK_ERROR", `m.myhome 网络错误：${(e as Error).message}`);
            }
            // 收 cookie（逐条解析 set-cookie）
            for (const sc of resp.headers.getSetCookie()) {
                const [pair] = sc.split(";");
                const eq = pair.indexOf("=");
                if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
            if (resp.status >= 300 && resp.status < 400) {
                const loc = resp.headers.get("location");
                if (!loc) break;
                current = new URL(loc, current).toString();
                body = undefined; // 重定向后变 GET
                continue;
            }
            return resp.text();
        }
        throw new ThuError("UPSTREAM_ERROR", "m.myhome 重定向次数过多");
    }

    /** 表单登录（幂等）。m.myhome 的身份认证页直接接受 info 学号+密码 */
    async login(): Promise<void> {
        if (this.loggedIn) return;
        const page = await this.req(AUTH_URL);
        const vs = grabHidden(page, "__VIEWSTATE");
        const vsg = grabHidden(page, "__VIEWSTATEGENERATOR");
        const ev = grabHidden(page, "__EVENTVALIDATION");
        if (!vs || !ev) {
            throw new ThuError("UPSTREAM_ERROR", "m.myhome 登录页结构变化（拿不到 ASP.NET 隐藏字段）");
        }
        const after = await this.req(AUTH_URL, {
            __VIEWSTATE: vs,
            __VIEWSTATEGENERATOR: vsg,
            __EVENTVALIDATION: ev,
            "weixin_user_authenticateCtrl1$txtUserName": config.thu.username,
            "weixin_user_authenticateCtrl1$txtPassword": config.thu.password,
            "weixin_user_authenticateCtrl1$btnLogin": "登录",
        });
        if (/身份认证/.test(after) && !/lblele/.test(after)) {
            throw new ThuError("AUTH_FAILED", "m.myhome 登录失败（仍停在身份认证页）");
        }
        this.loggedIn = true;
    }

    /** 查房间电量余额（度）。登录态失效会自动重登一次 */
    async getEleKwh(): Promise<MyhomeEleInfo> {
        await this.login();
        let html = await this.req(SEARCH_URL);
        if (/身份认证/.test(html) && !/lblele/.test(html)) {
            this.loggedIn = false; // 会话过期，重登一次
            await this.login();
            html = await this.req(SEARCH_URL);
        }
        const kwhText = grabSpan(html, "weixin_student_electricity_searchCtrl1_lblele");
        const kwh = Number(kwhText);
        if (!kwhText || !Number.isFinite(kwh)) {
            throw new ThuError("UPSTREAM_ERROR", "m.myhome 电费页解析失败（页面结构可能变了）");
        }
        return {
            studentId: grabSpan(html, "weixin_student_electricity_searchCtrl1_lblstudent_id"),
            name: grabSpan(html, "weixin_student_electricity_searchCtrl1_lblname"),
            building: grabSpan(html, "weixin_student_electricity_searchCtrl1_lbllouhao"),
            room: grabSpan(html, "weixin_student_electricity_searchCtrl1_lblroom"),
            kwh,
            meterTime: grabSpan(html, "weixin_student_electricity_searchCtrl1_lbltime"),
        };
    }
}

/** input hidden 字段抓取（登录页的 __VIEWSTATE 等是 input 不是 span） */
function grabHidden(html: string, id: string): string {
    const m = new RegExp(`id="${id}" value="([^"]*)"`).exec(html);
    return m?.[1] ?? "";
}
