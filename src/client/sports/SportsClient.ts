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
import {createHash, createDecipheriv} from "node:crypto";
import {config} from "../../config/env";
import {ThuError} from "../errors";

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
const RATE_LIMIT_BACKOFF_MS = 1500;

export interface SportsScene {
    uuid: string;
    sceneName: string;
    relatedType: string | null;
}

/** 一个场次（分时预约的最小单元，如 06:00-08:00） */
export interface SportsSession {
    /** "HH:MM" */
    start: string;
    end: string;
    /** 该场次当前是否可约 */
    available: boolean;
    /** 不可约原因（"当前场次预约人数已满"/"场次已被锁场"等），可约时无此字段 */
    reason?: string;
    /** 当前用户该场次价格（元，由分的 userFeeDetails 换算），未知为 null */
    feeYuan: number | null;
}

export interface SportsField {
    uuid: string;
    siteName: string;
    siteType: string;
    kindName: string;
    location: string;
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

export class SportsClient {
    private accessToken = "";
    /** 进行中的登录 Promise，防并发重复登录（与 lib 的 outstandingLoginPromise 同思路） */
    private loginPromise: Promise<void> | undefined;

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
            i_user: config.thu.username,
            i_pass: SM2_MAGIC_NUMBER + sm2.doEncrypt(config.thu.password, sm2PublicKey),
            fingerPrint: config.thu.fingerprint,
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
            throw new ThuError("NETWORK_ERROR", "体育系统网络请求失败，请检查网络后重试。", e);
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

    /** 统一 API 入口：确保已登录 + token 过期自动重登一次 + 限流退避重试 + 错误归一化 */
    private async api<T>(path: string, opts?: {method?: "GET" | "POST"; body?: unknown}): Promise<T> {
        await this.login();
        let result = (await this.rawRequest(path, opts)) as SportsApiResponse<T>;
        if (result.errorCode === LOGIN_EXPIRED_CODE) {
            this.accessToken = "";
            await this.login();
            result = (await this.rawRequest(path, opts)) as SportsApiResponse<T>;
        }
        // 服务端限流（"请求频繁，请稍后再试"）：退避后重试，级联查询容易触发
        for (let retry = 0; retry < RATE_LIMIT_MAX_RETRIES && result.message?.includes("请求频繁"); retry++) {
            await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS * (retry + 1)));
            result = (await this.rawRequest(path, opts)) as SportsApiResponse<T>;
        }
        if (result.code !== 0) {
            throw new ThuError("UPSTREAM_ERROR", `体育系统接口报错：${result.message ?? `code=${result.code}`}`);
        }
        return result.data as T;
    }

    /** 全部预约场景（气膜馆羽毛球、综体羽毛球、西体台球……） */
    async listScenes(): Promise<SportsScene[]> {
        return this.api<SportsScene[]>("/api/site/scene/list");
    }

    /** 场景的位置级联：校区 → 楼栋 → 楼层 → 房间，返回全部 ROOM 节点 */
    private async listRooms(sceneUuid: string): Promise<ChooseNode[]> {
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
        return nodes;
    }

    /**
     * 某场景某天的场地列表（含每块场地的可约状态）。
     * 服务端要求按"房间"维度查询（classTypeEnum=ROOM + classTypeUuid），
     * 否则返回空列表——先走位置级联拿到全部房间，再逐房间查询合并。
     */
    async getFieldPage(sceneUuid: string, date: string): Promise<SportsField[]> {
        const rooms = await this.listRooms(sceneUuid);
        const perRoom = await Promise.all(rooms.map((room) =>
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
                    sceneUseType: "SPORT_GROUP",
                    pageSize: 999,
                    pageNum: 1,
                },
            }),
        ));
        return perRoom.flat().map((f) => ({
            uuid: f.uuid,
            siteName: f.siteName,
            siteType: f.siteType,
            kindName: f.kindName,
            location: (f as unknown as {siteLocation?: {location?: string}}).siteLocation?.location ?? "",
            reserveStatus: f.reserveStatus ?? null,
            sessions: parseSessions(f),
            supportPeriod: (f as unknown as {supportPeriod?: string}).supportPeriod === "Y",
            bookableWindow: parseBookableWindow(f),
            feeRuleVo: f.feeRuleVo ?? null,
        }));
    }
}

/** sessionVo 原始条目（只取用到的字段） */
interface RawSession {
    beginTime?: string;
    endTime?: string;
    reserveStatus?: {reserveStatus?: string; reserveStatusReason?: string};
    userFeeDetails?: {chargingUnitPrice?: number};
}

/** 从 sessionVo 解析场次表，按开始时间排序 */
function parseSessions(f: SportsField): SportsSession[] {
    const raw = (f as unknown as {sessionVo?: RawSession[]}).sessionVo;
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((s) => s.beginTime && s.endTime)
        .map((s) => {
            const available = s.reserveStatus?.reserveStatus === "Y";
            return {
                start: s.beginTime!,
                end: s.endTime!,
                available,
                ...(!available && s.reserveStatus?.reserveStatusReason
                    ? {reason: s.reserveStatus.reserveStatusReason}
                    : {}),
                feeYuan: typeof s.userFeeDetails?.chargingUnitPrice === "number"
                    ? s.userFeeDetails.chargingUnitPrice / 100
                    : null,
            };
        })
        .sort((a, b) => a.start.localeCompare(b.start));
}

/** 从 reserveRule.laterLineTime 解析可约时间窗（"08:00:00" → "08:00"） */
function parseBookableWindow(f: SportsField): {start: string; end: string} | null {
    const ll = (f as unknown as {
        reserveRule?: {laterLineTime?: {lowerRange?: string; upperRange?: string}};
    }).reserveRule?.laterLineTime;
    if (!ll?.lowerRange || !ll?.upperRange) return null;
    return {start: ll.lowerRange.slice(0, 5), end: ll.upperRange.slice(0, 5)};
}
