/**
 * SportsClient —— 新版体育场馆预约系统（www.sports.tsinghua.edu.cn）的客户端。
 *
 * 背景：旧系统 50.tsinghua.edu.cn 已于 2026-08 整体下线（webvpn 全站 PARSE_FAILED），
 * @thu-info/lib 的 getSportsResources 随之永久失效。学校迁移到了正元智慧的
 * 商用场馆预约系统，公网直连、JSON API。本客户端依据 docs/sports-api-notes.md
 * （由 scripts/debug-sports*.ts 探路验证）实现。
 *
 * 与 ThuClient 的关系：两者服务完全不同的系统。这里只借用库的
 * uFetch/getRedirectUrl（补丁后的 cookie 跟随跳转能力），不借用其登录态。
 *
 * 职责：登录链、token 管理、请求签名、错误归一化。
 * 非职责：业务参数组装与输出裁剪 —— 那是 Skill 层的事。
 */
import {uFetch, getRedirectUrl} from "@thu-info/lib/dist/utils/network";
import {sm2} from "sm-crypto";
import {createHash, createDecipheriv, createCipheriv} from "node:crypto";
import "../../utils/httpProxy"; // 全局 fetch 走 https_proxy（若设置）
import {config} from "../../config/env";
import {ThuError} from "../errors";
import type {LoginCredentials} from "../auth";
import {resolveStableFingerprint} from "../fingerprintStore";

const SPORTS_BASE = "https://www.sports.tsinghua.edu.cn";
const SSO_ENTRY =
    `${SPORTS_BASE}/venue/site/authcenter/toLoginPage?redirectUrl=` +
    encodeURIComponent(`${SPORTS_BASE}/venue/index.html`) + "&typeCode=";
const ID_LOGIN_CHECK = "https://id.tsinghua.edu.cn/do/off/ui/auth/login/check";
const SM2_MAGIC_NUMBER = "04";

// 原厂前端混淆硬编码的签名/加密参数（docs/sports-api-notes.md 有出处）
const AES_KEY = "57325972627c40bd8c77296d39293705";
const APP_ID = "1497016617475903488";
const NONCE_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz0123456789";

/** 服务端约定：token 失效时返回此 errorCode */
const LOGIN_EXPIRED_CODE = 1130002;
/** 单个 API 请求的超时（毫秒） */
const API_TIMEOUT_MS = 30_000;
/** 限流重试：次数与基础退避（毫秒，线性递增） */
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 4000;
/** 限流防护：全局最小请求间隔。服务端有分钟级滚动窗口限流（2026-08-31 实测：
 *  瞬时几十请求超窗后，轻则所有查询返回"成功+空数据"，重则直接报"数据不存在"） */
const MIN_REQUEST_INTERVAL_MS = 300;

export interface SportsScene {
    uuid: string;
    sceneName: string;
    relatedType: string | null;
}

/** 一个场次（分时预约的最小单元，如 06:00-08:00） */
export interface SportsSession {
    /** 场次 uuid（预约提交时的 sessionDetailUuid） */
    uuid: string;
    /** "HH:MM" */
    start: string;
    end: string;
    /** 该场次当前是否可约 */
    available: boolean;
    /** 不可约原因（"当前场次预约人数已满"/"场次已被锁场"等），可约时无此字段 */
    reason?: string;
    /** 当前用户该场次价格（元，由分的 userFeeDetails 换算），未知为 null */
    feeYuan: number | null;
    /** 该场次要求的支付方式（userFeeDetails.payType，如 PAY_ONLINE/PAY_OFFLINE）。
     *  下单必须按它传，否则被拒（"当前开始时间不支持线下支付"，2026-08-29 实测） */
    payType?: string;
}

export interface SportsField {
    uuid: string;
    siteName: string;
    siteType: string;
    kindName: string;
    location: string;
    /** 所属场景 uuid（预约提交用） */
    sceneUuid: string;
    reserveStatus: {
        reserveStatus: "Y" | "N";
        reserveStatusReason?: string;
        /**
         * 注意：这是"未被任何场次/预约覆盖的空白时间段"，不是"开放可约时间段"！
         * 场馆打烊后（如 22:00-23:59）没有场次，会在这里显示成"空闲"——不可用于可约判定。
         * 可约性以 sessions 为准（2026-08-29 用户实锤纠正，见 docs/sports-api-notes.md）。
         */
        availableRange: {startTime: string; endTime: string}[];
    } | null;
    /**
     * 场次表（真正的可约单元）。空数组表示该场地按自由时段预约
     * （supportPeriod=true），此时才参考 availableRange。
     */
    sessions: SportsSession[];
    /** 是否支持自由时段预约（supportPeriod === "Y"） */
    supportPeriod: boolean;
    /** 申请表单 uuid（formRuleVo.formUuid，无表单时为 ""）。预约提交的 formParam.formId 用 */
    formUuid: string;
    /** 实际可约时间窗（来自 reserveRule.laterLineTime，如 08:00-23:59），未知为 null */
    bookableWindow: {start: string; end: string} | null;
    feeRuleVo: unknown;
}

/** 位置级联节点（校区→楼栋→楼层→房间） */
interface ChooseNode {
    uuid: string;
    siteName: string;
    siteType: string;
}

interface SportsApiResponse<T> {
    code: number;
    message?: string;
    success?: boolean;
    errorCode?: number;
    data?: T;
    count?: number;
}

/** 当前登录用户信息（getLoginUser） */
export interface SportsUser {
    id: string;
    nickName?: string;
    account?: string;
}

/** 滑块拼图验证码（getDragCaptcha 的返回） */
export interface DragCaptcha {
    token: string;
    /** AES-128-ECB 密钥（每次验证码会话独立） */
    secretKey: string;
    /** 背景图（base64 PNG） */
    backgroundBase64: string;
    /** 拼图块（base64 PNG） */
    jigsawBase64: string;
}

/** AES-128-ECB + PKCS7，base64 输出（对齐前端 CryptoJS 与旧项目 captcha.py） */
function aes128EcbEncrypt(plain: string, key: string): string {
    const c = createCipheriv("aes-128-ecb", Buffer.from(key, "utf8"), null);
    return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
}

/** 预约下单结果 */
export interface BookResult {
    /** 预约记录 uuid 列表 */
    resvIds: string[];
    /** 是否生成了订单 */
    orderGenerated: boolean;
    /** 是否免支付（免费场次） */
    freeOrder: boolean;
}

/**
 * 我的订单（/api/order/orderRecord 条目），字段形状经 2026-08-30 真实链路探测确认。
 * 注意：列表层的 orderStatus/payType 是数字码，详情层（/resv/order）是同义字符串。
 */
export interface SportsOrder {
    /** 订单 uuid（支付提交 placePayOrder、取消 cancelOrder 都用它） */
    uuid: string;
    orderNo?: string;
    /** 订单状态位掩码（列表层数字）：1=待支付 2=支付中 4=已支付 8=已取消 16=支付超时。
     *  权威判定以 getOrderDetail 的字符串 orderStatus 为准（"TO_BE_PAID"/"PAID"/"CANCEL"） */
    orderStatus?: number;
    /** 支付方式数字码：1=线上支付（实测，2026-08-30） */
    payType?: number;
    /** 应付金额（分） */
    payableAmount?: number;
    /** 实付金额（分） */
    paidAmount?: number;
    orderCreateTime?: string;
    /** 支付截止时间 "yyyy-MM-dd HH:mm:ss" */
    paymentDeadline?: string;
    /** 订单明细：预约信息在 resvReserveVo（uuid = 预约记录 uuid，查订单详情要用它） */
    orderDetails?: {
        resvUuid?: string;
        resvReserveVo?: {
            uuid?: string;
            resvBeginTime?: string;
            resvEndTime?: string;
            resvStatus?: string;
        };
        timeRange?: {startTime?: string; endTime?: string};
        siteInfo?: {id?: string; uuid?: string; siteName?: string; siteType?: string};
    }[];
}

/** 支付渠道（/api/resv/trade/pay/type 条目）。实测：气膜馆只有 tsinghua_pc_9 一个 */
export interface SportsPayChannel {
    channelId: string;
    name: string;
    property?: number;
}

/** 订单详情（GET /resv/order）里用到的字段（2026-08-30 实测） */
export interface SportsOrderDetail {
    /** 订单 uuid（与列表层一致） */
    uuid?: string;
    /** 字符串状态："TO_BE_PAID"/"PAID"/"CANCEL" 等 */
    orderStatus?: string;
    /** 字符串支付方式："PAY_ONLINE"/"PAY_OFFLINE" */
    payType?: string;
    /** 应付金额（分） */
    payableAmount?: number;
    reservations?: {
        siteUuid?: string;
        siteType?: string;
        resvBeginTime?: string;
        resvEndTime?: string;
    }[];
}

/**
 * placeOrder 的返回：displayMode 决定前端怎么展示
 * （chunk-03b08403 等多个页面一致的处理逻辑）：
 * - "url"        → displayContent 是跳转链接
 * - "qr_code_url"/"qr_code" → displayContent 是二维码内容/图片地址
 * - "form"       → displayContent 是自动提交的 HTML 表单（POST 到学校财务平台
 *                  fa-online.tsinghua.edu.cn，2026-08-30 实测气膜馆渠道就是它）
 */
export interface SportsPayLaunch {
    displayMode: "url" | "qr_code_url" | "qr_code" | "form" | string;
    displayContent: string;
}

export class SportsClient {
    private readonly credentials?: LoginCredentials;
    private accessToken = "";
    /** 进行中的登录 Promise，防并发重复登录（与 lib 的 outstandingLoginPromise 同思路） */
    private loginPromise: Promise<void> | undefined;
    /** 位置级联缓存（sceneUuid → ROOM 节点）：场景房间结构天级不变，进程内复用，
     *  每次场地查询可省 4+N 个请求（限流防护，2026-08-31） */
    private readonly roomsCache = new Map<string, ChooseNode[]>();
    /** 请求节流闸门：所有 API 请求在此串行排队，保证最小间隔（限流防护） */
    private throttleGate: Promise<void> = Promise.resolve();
    private lastRequestAt = 0;

    constructor(credentials?: LoginCredentials) {
        this.credentials = credentials;
    }

    /** 过一道最小间隔闸（串行排队），把瞬时并发摊平以避开服务端滚动窗口限流 */
    private async throttle(): Promise<void> {
        const gate = this.throttleGate.then(async () => {
            const wait = this.lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            this.lastRequestAt = Date.now();
        });
        this.throttleGate = gate;
        await gate;
    }

    /** 登录（幂等）。完整链：SSO → 直连 ID 登录 → 回调 → uniToken → accessToken */
    async login(): Promise<void> {
        if (this.accessToken) return;
        this.loginPromise ??= this.doLogin().finally(() => {
            this.loginPromise = undefined;
        });
        return this.loginPromise;
    }

    private async doLogin(): Promise<void> {
        // ① SSO 入口 → 应落在 id.tsinghua.edu.cn 直连登录表单
        const formUrl = await getRedirectUrl(SSO_ENTRY);
        if (!formUrl?.includes("id.tsinghua.edu.cn") || !formUrl.includes("/auth/login/form")) {
            // 系统维护时 SSO 入口不跳转，直接返回 200 + 维护公告 JSON
            const maintenance = await this.probeMaintenance();
            if (maintenance) throw new ThuError("MAINTENANCE", maintenance);
            throw new ThuError("UPSTREAM_ERROR", `体育系统 SSO 链异常，终点：${formUrl}`);
        }
        // ② 表单页抓 SM2 公钥（与库登录同一方案）
        const formHtml = await uFetch(formUrl);
        const sm2PublicKey = /id="sm2publicKey"[^>]*>([0-9a-fA-F]+)</.exec(formHtml)?.[1];
        if (!sm2PublicKey) {
            throw new ThuError("UPSTREAM_ERROR", "统一身份认证登录表单结构变化：找不到 sm2publicKey");
        }
        // ③ 直连提交凭证（复用指纹信任设备，正常不会触发 2FA）
        const loginResp = await uFetch(ID_LOGIN_CHECK, {
            i_user: this.credentials?.username ?? config.thu.username,
            i_pass: SM2_MAGIC_NUMBER + sm2.doEncrypt(this.credentials?.password ?? config.thu.password, sm2PublicKey),
            fingerPrint: resolveStableFingerprint(this.credentials?.fingerprint),
            fingerGenPrint: "",
            i_captcha: "",
        });
        if (loginResp.includes("二次认证")) {
            throw new ThuError(
                "AUTH_REQUIRED",
                "体育系统登录链触发了二次认证。请先运行 pnpm step2 完成一次交互式登录以刷新信任设备。",
            );
        }
        if (!loginResp.includes("登录成功。正在重定向到")) {
            throw new ThuError("AUTH_FAILED", "统一身份认证直连登录失败（凭证错误或页面结构变化）");
        }
        // ④ 跟进回调链 → uniToken（服务端在这一步才种会话，不能省）
        const callbackUrl = /href="([^"]+)"/.exec(loginResp)?.[1];
        if (!callbackUrl) {
            throw new ThuError("UPSTREAM_ERROR", "统一身份认证登录成功页缺少回调链接");
        }
        const afterCallback = await getRedirectUrl(callbackUrl);
        const uniToken = /[?&]uniToken=([0-9a-f]+)/.exec(afterCallback ?? "")?.[1];
        if (!uniToken) {
            throw new ThuError("UPSTREAM_ERROR", `体育系统回调未发放 uniToken，终点：${afterCallback}`);
        }
        // ⑤ uniToken 换 accessToken
        const tokenResp = await this.rawRequest("/cas/token", {
            method: "POST",
            body: {platForm: "CAS", client: "PC", token: uniToken},
        });
        const tokenJson = tokenResp as SportsApiResponse<{token: string}>;
        if (tokenJson.code !== 0 || !tokenJson.data?.token) {
            throw new ThuError("UPSTREAM_ERROR", `体育系统 cas/token 失败：${tokenJson.message ?? "未知"}`);
        }
        this.accessToken = tokenJson.data.token;
    }

    /** 系统维护探测：返回人性化的维护提示，不在维护期返回 null */
    private async probeMaintenance(): Promise<string | null> {
        try {
            const body = await uFetch(SSO_ENTRY);
            const m = /系统维护中[，,]?\s*维护时间([^"]+)/.exec(body);
            if (m) return `体育系统维护中（维护时间${m[1].trim()}），请维护结束后再试。`;
        } catch { /* 探测失败就走原报错 */ }
        return null;
    }

    /** 请求签名参数（每个 API 调用都要，见 docs/sports-api-notes.md） */
    private signParams(): string {
        const nonce = Array.from({length: 32},
            () => NONCE_ALPHABET[Math.floor(Math.random() * NONCE_ALPHABET.length)]).join("");
        const timeStamp = Date.now();
        const sign = createHash("md5")
            .update(`appId=${APP_ID}&nonce=${nonce}&timeStamp=${timeStamp}&key=${AES_KEY}`)
            .digest("hex");
        return `appId=${APP_ID}&nonce=${nonce}&timeStamp=${timeStamp}&sign=${sign}`;
    }

    /** 底层请求：签名 + token 头 + 超时 + 加密响应兜底解密 */
    private async rawRequest(
        path: string,
        opts: {method?: "GET" | "POST"; body?: unknown; authed?: boolean} = {},
    ): Promise<unknown> {
        const sep = path.includes("?") ? "&" : "?";
        let resp: Response;
        try {
            resp = await fetch(`${SPORTS_BASE}/venue/site${path}${sep}${this.signParams()}`, {
                method: opts.method ?? "GET",
                signal: AbortSignal.timeout(API_TIMEOUT_MS),
                headers: {
                    ...(opts.authed !== false && this.accessToken ? {token: this.accessToken} : {}),
                    // 关键：服务端按此头区分 API 版本，缺了会走旧版逻辑——
                    // 所有场地返回"申请表单信息缺失"（2026-08-28 消融实验确认）
                    "x-api-version": "2.0.0",
                    ...(opts.body !== undefined ? {"Content-Type": "application/json"} : {}),
                },
                ...(opts.body !== undefined ? {body: JSON.stringify(opts.body)} : {}),
            });
        } catch (e) {
            if (e instanceof Error && e.name === "TimeoutError") {
                throw new ThuError("TIMEOUT", "体育系统请求超时，稍后重试通常有效。", e);
            }
            // 透出 cause 链上的真实原因（ECONNRESET/ENOTFOUND/…），"fetch failed" 本身没有信息量
            throw new ThuError("NETWORK_ERROR", `体育系统网络请求失败（${networkCause(e)}），稍后重试通常有效。`, e);
        }
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch {
            // 个别端点返回 AES 密文（兜底；当前用到的端点都是明文 JSON）
            try {
                const d = createDecipheriv("aes-256-cbc", Buffer.from(AES_KEY, "utf8"), Buffer.alloc(16, "0"));
                d.setAutoPadding(false);
                const plain = d.update(text, "base64", "utf8") + d.final("utf8");
                return JSON.parse(plain.slice(0, plain.length - plain.charCodeAt(plain.length - 1)));
            } catch {
                throw new ThuError("UPSTREAM_ERROR", `体育系统返回了无法解析的响应（HTTP ${resp.status}）`);
            }
        }
    }

    /** 统一 API 入口：登录保活 + 最小间隔节流 + token 过期自动重登一次 + 限流退避重试 + 网络抖动重试 + 错误归一化 */
    private async api<T>(path: string, opts?: {method?: "GET" | "POST"; body?: unknown}): Promise<T> {
        await this.login();
        await this.throttle();
        let result = (await this.requestWithNetworkRetry(path, opts)) as SportsApiResponse<T>;
        if (result.errorCode === LOGIN_EXPIRED_CODE) {
            this.accessToken = "";
            await this.login();
            result = (await this.requestWithNetworkRetry(path, opts)) as SportsApiResponse<T>;
        }
        // 服务端限流（"请求频繁，请稍后再试"）：退避后重试，级联查询容易触发
        for (let retry = 0; retry < RATE_LIMIT_MAX_RETRIES && result.message?.includes("请求频繁"); retry++) {
            await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS * (retry + 1)));
            result = (await this.requestWithNetworkRetry(path, opts)) as SportsApiResponse<T>;
        }
        if (result.code !== 0) {
            // 系统维护公告（"系统维护中, 维护时间01:00 - 02:00"）单独成类，便于模型如实转告
            if (result.message?.includes("系统维护中")) {
                throw new ThuError("MAINTENANCE", `体育系统维护中（${result.message}），请维护结束后再试。`);
            }
            throw new ThuError("UPSTREAM_ERROR", `体育系统接口报错：${result.message ?? `code=${result.code}`}`);
        }
        return result.data as T;
    }

    /**
     * 网络层失败（TIMEOUT/NETWORK_ERROR）退避重试。
     * 全场景查询要串行发百余个请求，任何一次抖动都不应让整体失败。
     */
    private async requestWithNetworkRetry(
        path: string,
        opts?: {method?: "GET" | "POST"; body?: unknown},
    ): Promise<unknown> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.rawRequest(path, opts);
            } catch (e) {
                const retriable = e instanceof ThuError && (e.code === "NETWORK_ERROR" || e.code === "TIMEOUT");
                if (!retriable || attempt >= RATE_LIMIT_MAX_RETRIES) throw e;
                await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS * (attempt + 1)));
            }
        }
    }

    /** 全部预约场景（气膜馆羽毛球、综体羽毛球、西体台球……） */
    async listScenes(): Promise<SportsScene[]> {
        return this.api<SportsScene[]>("/api/site/scene/list");
    }

    /** 当前登录用户（预约提交的 resvMember 需要用户 id） */
    async getLoginUser(): Promise<SportsUser> {
        return this.api<SportsUser>("/system/login/getLoginUser");
    }

    /** 预约提交是否需要滑块验证码（/api/reserve/enableValidCode，配置项 RESV_CODE，"1"=开启） */
    async isCaptchaEnabled(): Promise<boolean> {
        const r = await this.api<{sysValue?: string}>("/api/reserve/enableValidCode");
        return r?.sysValue === "1";
    }

    /**
     * 拉取滑块拼图验证码（AJ-Captcha blockPuzzle）。
     * 注意：这两个端点的响应外壳是 {success, repData}，不是通常的 {code, data}。
     */
    async getDragCaptcha(): Promise<DragCaptcha> {
        await this.login();
        const resp = (await this.rawRequest("/system/captcha/drag/get", {
            method: "POST",
            body: {
                captchaType: "blockPuzzle",
                clientUid: createHash("md5").update(`${Date.now()}${Math.random()}`).digest("hex"),
                ts: Date.now(),
            },
        })) as {success?: boolean; repData?: Record<string, string>};
        const d = resp.repData ?? {};
        if (!resp.success || !d.secretKey || !d.token || !d.originalImageBase64 || !d.jigsawImageBase64) {
            throw new ThuError("UPSTREAM_ERROR", "滑块验证码拉取失败（响应结构不完整）");
        }
        return {
            token: d.token,
            secretKey: d.secretKey,
            backgroundBase64: d.originalImageBase64,
            jigsawBase64: d.jigsawImageBase64,
        };
    }

    /**
     * 校验一个滑块候选位置（不抛异常，返回是否通过）。
     * pointJson = AES-128-ECB-PKCS7 加密 {"x":X,"y":5}（key=secretKey）。
     *
     * 注意（真实抓包确认）：校验通过时服务端会在 repData.token 里下发
     * 一个新 token，addReserve 的 captcha 字段必须用这个新 token 计算，
     * 所以通过时本方法会直接更新 cap.token。
     */
    async checkDragCaptcha(cap: DragCaptcha, x: number): Promise<boolean> {
        const pointJson = aes128EcbEncrypt(JSON.stringify({x, y: 5}), cap.secretKey);
        const resp = (await this.rawRequest("/system/captcha/drag/check", {
            method: "POST",
            body: {captchaType: "blockPuzzle", pointJson, token: cap.token},
        })) as {success?: boolean; repCode?: string; repMsg?: string; repData?: {result?: boolean; token?: string}};
        const passed = resp.success === true && resp.repData?.result === true;
        if (!passed) {
            // 失败时保留服务端原因，便于区分"位置不对"和"token 失效"
            console.error(`  [drag/check 失败] X=${x} repCode=${resp.repCode ?? "?"} repMsg=${resp.repMsg ?? "?"}`);
        }
        if (passed && resp.repData?.token) {
            cap.token = resp.repData.token;
        }
        return passed;
    }

    /** 校验通过后，生成 addReserve 的 captcha 字段值：AES(token + "---" + {"x":X,"y":5}) */
    buildCaptchaValue(cap: DragCaptcha, x: number): string {
        return aes128EcbEncrypt(`${cap.token}---${JSON.stringify({x, y: 5})}`, cap.secretKey);
    }


    /**
     * 预约一个场次（写操作，会真实下单）。
     * 链路与前端一致：addReserve → orderCheck（判断是否生成了待支付订单）。
     * 载荷结构经过双重来源核对：前端 chunk 静态分析 + 用户此前抢场项目
     * （auto--badminton-booking-system）的真实抓包（docs/sports-api-notes.md）。
     *
     * 注意两个实战细节（来自真实抓包，与前端代码有出入，以抓包为准）：
     * - sessionDetailUuid 只放 siteSessionReserve，reserveTime 只带起止时间
     * - payType 默认 PAY_OFFLINE（线下支付）：不触发线上扣款订单
     */
    async bookSession(req: {
        sceneUuid: string;
        sceneUseType: string;
        siteUuid: string;
        siteType: string;
        /** 场地的申请表单 uuid（SportsField.formUuid），无表单传 "" */
        formUuid: string;
        sessionUuid: string;
        /** 场次日期 YYYY-MM-DD 与起止 "HH:MM" */
        date: string;
        startTime: string;
        endTime: string;
        /** 滑块验证码 token（enableValidCode 开启时必须）；默认空 */
        captcha?: string;
        /** 支付方式：必须传场次的 session.payType（有些时段只支持线上支付）。
         *  场次没标时回退 PAY_OFFLINE（不动线上资金） */
        payType?: string;
    }): Promise<BookResult> {
        const user = await this.getLoginUser();
        // 前端流程：场地有申请表单（formRuleVo.formUuid）时，先查
        // /workflow/process/brief/{formUuid} 拿 deployUuid，两个 id 一起进
        // formParam，否则服务端报"表单信息不能为空"（2026-08-29 实测）
        let deployUuid = "";
        if (req.formUuid) {
            const brief = await this.api<{deployUuid?: string}>(
                `/workflow/process/brief/${req.formUuid}`,
            );
            deployUuid = brief?.deployUuid ?? "";
        }
        const timeRange = {
            startTime: `${req.date} ${req.startTime}:00`,
            endTime: `${req.date} ${req.endTime}:00`,
        };
        const sessionItem = {sessionDetailUuid: req.sessionUuid, reserveTime: timeRange};
        const added = await this.api<{resvIds?: string[]} | string[]>("/api/reserve/addReserve", {
            method: "POST",
            body: {
                sceneUuid: req.sceneUuid,
                sceneUseType: req.sceneUseType,
                siteUuid: req.siteUuid,
                siteType: req.siteType,
                reserveTime: [timeRange],
                siteSessionReserve: [sessionItem],
                resvMember: [user.id],
                resvKind: "CURRENT_RESERVE",
                payType: req.payType ?? "PAY_OFFLINE",
                purchaseUuid: "",
                formParam: {
                    formId: req.formUuid,
                    deployUuid,
                    variables: {},
                    chooseCandidates: {},
                },
                captcha: req.captcha ?? "",
            },
        });
        // addReserve 的 data：单场为 {resvIds:[...]}，多场为 [...]（前端两种都处理）
        const resvIds = Array.isArray(added) ? added : added?.resvIds ?? [];
        const check = await this.api<{orderGenerated?: boolean; freeOrder?: boolean}>(
            "/resv/order/check",
            {method: "POST", body: {resvUuidList: resvIds, userId: user.id}},
        );
        return {
            resvIds,
            orderGenerated: check?.orderGenerated ?? false,
            freeOrder: check?.freeOrder ?? false,
        };
    }

    /**
     * 我的订单记录（POST /api/order/orderRecord）。
     * 与前端"我的预约"页一致：按创建时间倒序分页。
     * 注意：api() 只返回 result.data（数组），总数在 result.count，这里用不上。
     */
    async listMyOrders(pageSize = 20): Promise<SportsOrder[]> {
        return this.api<SportsOrder[]>("/api/order/orderRecord", {
            method: "POST",
            body: {pageSize, pageNum: 1, orderItems: "gmt_create", orderRule: "desc"},
        });
    }

    /**
     * 某场地的线上支付渠道（GET /api/resv/trade/pay/type）。
     * 前端固定传 terminal:"PC" + 订单第一条预约的 siteUuid/siteType。
     */
    async getPayChannels(siteUuid: string, siteType: string): Promise<SportsPayChannel[]> {
        const q = `terminal=PC&siteUuid=${encodeURIComponent(siteUuid)}&siteType=${encodeURIComponent(siteType)}`;
        return this.api<SportsPayChannel[]>(`/api/resv/trade/pay/type?${q}`);
    }

    /**
     * 发起支付（POST /api/resv/trade/place/order）。
     * 只生成支付参数（二维码/链接），不移动资金——用户扫码后在手机上确认才扣款。
     * returnUrl 是支付完成后前端回跳地址，对扫码场景无实际作用，照前端格式传。
     */
    async placePayOrder(orderUuid: string, channelId: string): Promise<SportsPayLaunch> {
        const data = await this.api<SportsPayLaunch | undefined>("/api/resv/trade/place/order", {
            method: "POST",
            body: {
                orderUuid,
                channelId,
                returnUrl: `${SPORTS_BASE}/venue/index.html#/personal`,
            },
        });
        if (!data?.displayMode || !data.displayContent) {
            throw new ThuError("UPSTREAM_ERROR", "体育系统支付下单返回结构不完整（缺 displayMode/displayContent）");
        }
        return data;
    }

    /** 查订单详情（GET /resv/order?resvUuid=）——前端支付后轮询它确认 PAID/CANCEL。
     *  注意：参数是预约记录的 uuid（orderDetails[].resvReserveVo.uuid），不是订单 uuid */
    async getOrderDetail(resvUuid: string): Promise<SportsOrderDetail | undefined> {
        return this.api<SportsOrderDetail>(
            `/resv/order?resvUuid=${encodeURIComponent(resvUuid)}`,
        );
    }

    /** 取消未支付订单（POST /resv/order/cancel {uuid: 订单 uuid}），前端支付页同款 */
    async cancelOrder(orderUuid: string): Promise<void> {
        await this.api<unknown>("/resv/order/cancel", {method: "POST", body: {uuid: orderUuid}});
    }

    /** 场景的位置级联：校区 → 楼栋 → 楼层 → 房间，返回全部 ROOM 节点。
     *  结果进程内缓存（房间结构天级不变），失败不缓存，下次重查 */
    private async listRooms(sceneUuid: string): Promise<ChooseNode[]> {
        const cached = this.roomsCache.get(sceneUuid);
        if (cached) return cached;
        let nodes = await this.api<ChooseNode[]>(
            `/api/site/choose?sceneUuid=${sceneUuid}&siteType=CAMPUS&siteUuid=`,
        ) ?? [];
        for (const level of ["BUILDING", "FLOOR", "ROOM"] as const) {
            const next: ChooseNode[] = [];
            for (const n of nodes) {
                const children = await this.api<ChooseNode[]>(
                    `/api/site/choose?sceneUuid=${sceneUuid}&siteType=${level}&siteUuid=${n.uuid}`,
                );
                next.push(...(children ?? []));
            }
            nodes = next;
        }
        if (nodes.length > 0) this.roomsCache.set(sceneUuid, nodes);
        return nodes;
    }

    /**
     * 某场景某天的场地列表（含每块场地的可约状态）。
     * 服务端要求按"房间"维度查询（classTypeEnum=ROOM + classTypeUuid），
     * 否则返回空列表——先走位置级联拿到全部房间，再逐房间查询合并。
     *
     * sceneUseType 两轮查询：球类是团体场地模式（SPORT_GROUP）；游泳馆等
     * 个人票务场馆在团体视角下恒定返回空，必须用个人模式（SPORT_PERSON）
     * 重查（2026-09-02 用户抓包实锤，8-31"有位报满"的真正根因）。
     * 球类第一轮就有数据，不会多花请求。
     */
    async getFieldPage(sceneUuid: string, date: string): Promise<SportsField[]> {
        const rooms = await this.listRooms(sceneUuid);
        const query = (sceneUseType: string) => Promise.all(rooms.map((room) =>
            this.api<SportsField[]>("/api/reserve/current/page", {
                method: "POST",
                body: {
                    sceneUuid,
                    resvKind: "CURRENT_RESERVE",
                    siteType: "DEV",
                    searchValue: "",
                    siteKindId: "",
                    classTypeEnum: "ROOM",
                    classTypeUuid: room.uuid,
                    reserveDate: date,
                    sceneUseType,
                    pageSize: 999,
                    pageNum: 1,
                },
            }),
        ));
        let perRoom = await query("SPORT_GROUP");
        if (perRoom.flat().length === 0) perRoom = await query("SPORT_PERSON");
        return perRoom.flat().map((f) => ({
            uuid: f.uuid,
            siteName: f.siteName,
            siteType: f.siteType,
            kindName: f.kindName,
            location: (f as unknown as {siteLocation?: {location?: string}}).siteLocation?.location ?? "",
            sceneUuid,
            reserveStatus: f.reserveStatus ?? null,
            sessions: parseSessions(f),
            supportPeriod: (f as unknown as {supportPeriod?: string}).supportPeriod === "Y",
            formUuid: (f as unknown as {formRuleVo?: {formUuid?: string} | null}).formRuleVo?.formUuid ?? "",
            bookableWindow: parseBookableWindow(f),
            feeRuleVo: f.feeRuleVo ?? null,
        }));
    }
}

/** sessionVo 原始条目（只取用到的字段） */
interface RawSession {
    uuid?: string;
    beginTime?: string;
    endTime?: string;
    reserveStatus?: {reserveStatus?: string; reserveStatusReason?: string};
    userFeeDetails?: {chargingUnitPrice?: number; payType?: number};
}

/** 场次数据里 payType 是数字码，前端映射表（chunk-0e504f6d）：1→线上 2→线下 3→线上 */
const PAY_TYPE_MAP: Record<number, string> = {1: "PAY_ONLINE", 2: "PAY_OFFLINE", 3: "PAY_ONLINE"};

/** 从 sessionVo 解析场次表，按开始时间排序 */
function parseSessions(f: SportsField): SportsSession[] {
    const raw = (f as unknown as {sessionVo?: RawSession[]}).sessionVo;
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((s) => s.uuid && s.beginTime && s.endTime)
        .map((s) => {
            const available = s.reserveStatus?.reserveStatus === "Y";
            return {
                uuid: s.uuid!,
                start: s.beginTime!,
                end: s.endTime!,
                available,
                ...(!available && s.reserveStatus?.reserveStatusReason
                    ? {reason: s.reserveStatus.reserveStatusReason}
                    : {}),
                feeYuan: typeof s.userFeeDetails?.chargingUnitPrice === "number"
                    ? s.userFeeDetails.chargingUnitPrice / 100
                    : null,
                ...(typeof s.userFeeDetails?.payType === "number" && PAY_TYPE_MAP[s.userFeeDetails.payType]
                    ? {payType: PAY_TYPE_MAP[s.userFeeDetails.payType]}
                    : {}),
            };
        })
        .sort((a, b) => a.start.localeCompare(b.start));
}

/** 从 fetch 的 cause 链里挖出真正的底层原因（ECONNRESET/ENOTFOUND/…） */
function networkCause(e: unknown): string {
    let cur: unknown = e;
    const parts: string[] = [];
    while (cur instanceof Error) {
        parts.push(cur.message);
        cur = cur.cause;
    }
    return parts.join(" ← ");
}

/** 从 reserveRule.laterLineTime 解析可约时间窗（"08:00:00" → "08:00"） */
function parseBookableWindow(f: SportsField): {start: string; end: string} | null {
    const ll = (f as unknown as {
        reserveRule?: {laterLineTime?: {lowerRange?: string; upperRange?: string}};
    }).reserveRule?.laterLineTime;
    if (!ll?.lowerRange || !ll?.upperRange) return null;
    return {start: ll.lowerRange.slice(0, 5), end: ll.upperRange.slice(0, 5)};
}
