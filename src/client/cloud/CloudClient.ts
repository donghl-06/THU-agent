/**
 * CloudClient —— 清华云盘（Seafile）客户端。
 *
 * 云盘登录链：cloud session → 清华 OAuth → 统一身份认证 → OAuth callback。
 * 这里不复用 @thu-info/lib 的全局 cookie jar：cloud、oauth 和 id 都可能下发
 * sessionid/JSIONID 这类同名 Cookie，按域名隔离才能避免互相覆盖。
 *
 * 登录成功后优先通过 Seafile 的 session-token 端点换取 Web API Token；
 * 如果学校未开启该端点，则退回用云盘网页会话调用只读 API。
 * Token 只保存在进程内存，不写日志、不返回给 Skill/LLM。
 */
import {sm2} from "sm-crypto";
import {config} from "../../config/env";
import {ThuError} from "../errors";
import type {LoginCredentials} from "../auth";
import {resolveStableFingerprint} from "../fingerprintStore";
import "../../utils/httpProxy";

const CLOUD_BASE = "https://cloud.tsinghua.edu.cn";
const SSO_ENTRY = `${CLOUD_BASE}/sso/?next=/`;
const TOKEN_BY_SESSION_URL = `${CLOUD_BASE}/api/v2.1/auth-token-by-session/`;
const ID_LOGIN_CHECK = "https://id.tsinghua.edu.cn/do/off/ui/auth/login/check";
const SM2_MAGIC_NUMBER = "04";
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 15;
const REQUEST_TIMEOUT_MS = 30_000;

export interface CloudLibrary {
    id: string;
    name: string;
    type: string;
    ownerName: string;
    sizeBytes: number | null;
    modifiedAt: string | null;
    permission: string | null;
    encrypted: boolean;
}

export interface CloudDirent {
    name: string;
    type: "file" | "dir";
    path: string;
    sizeBytes: number | null;
    modifiedAt: string | null;
    permission: string | null;
}

export interface CloudSearchResult {
    name: string;
    path: string;
    repoId: string;
    repoName: string;
    isFile: boolean;
    sizeBytes: number | null;
    modifiedAt: string | null;
}

export interface CloudFile {
    repoId: string;
    path: string;
    name: string;
    sizeBytes: number | null;
    modifiedAt: string | null;
    permission: string | null;
    canPreview: boolean;
}

interface RawRepo {
    id?: string;
    repo_id?: string;
    name?: string;
    repo_name?: string;
    type?: string;
    owner_name?: string;
    owner?: string;
    size?: number;
    mtime?: number | string;
    last_modified?: string;
    permission?: string;
    encrypted?: boolean;
}

interface RawDirent {
    name?: string;
    type?: string;
    parent_dir?: string;
    size?: number;
    mtime?: number | string;
    permission?: string;
}

interface RawSearchResult {
    name?: string;
    title?: string;
    fullpath?: string;
    path?: string;
    repo_id?: string;
    repoId?: string;
    repo_name?: string;
    repoName?: string;
    type?: string;
    size?: number;
    mtime?: number | string;
}

interface RawFileDetail {
    name?: string;
    obj_name?: string;
    size?: number | string;
    mtime?: number | string;
    last_modified?: string;
    permission?: string;
    can_preview?: boolean;
}

function cookieNameValue(setCookie: string): [string, string] | undefined {
    const [pair] = setCookie.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return undefined;
    return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
}

function normalizeTime(value: number | string | undefined): string | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return new Date(value * 1000).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return new Date(numeric * 1000).toISOString();
        }
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
    return null;
}

function normalizeRepo(raw: RawRepo): CloudLibrary | undefined {
    const id = raw.id ?? raw.repo_id;
    const name = raw.name?.trim() ?? raw.repo_name?.trim();
    if (!id || !name) return undefined;
    return {
        id,
        name,
        type: raw.type ?? "",
        ownerName: raw.owner_name ?? raw.owner ?? "",
        sizeBytes: typeof raw.size === "number" && raw.size >= 0 ? raw.size : null,
        modifiedAt: normalizeTime(raw.mtime ?? raw.last_modified),
        permission: raw.permission ?? null,
        encrypted: raw.encrypted === true,
    };
}

function joinCloudPath(parent: string | undefined, name: string | undefined): string | undefined {
    if (!name) return undefined;
    const base = parent && parent.startsWith("/") ? parent : "/";
    return `${base.replace(/\/+$/, "")}/${name}`.replace(/^\/+/, "/");
}

function normalizeDirent(raw: RawDirent, parentPath: string): CloudDirent | undefined {
    const name = raw.name?.trim();
    if (!name) return undefined;
    const type = raw.type === "dir" || raw.type === "folder" ? "dir" : "file";
    return {
        name,
        type,
        path: joinCloudPath(parentPath, name) ?? `/${name}`,
        sizeBytes: type === "file" && typeof raw.size === "number" && raw.size >= 0 ? raw.size : null,
        modifiedAt: normalizeTime(raw.mtime),
        permission: raw.permission ?? null,
    };
}

function normalizeSearchResult(raw: RawSearchResult): CloudSearchResult | undefined {
    const name = raw.name?.trim() ?? raw.title?.trim();
    const repoId = raw.repo_id ?? raw.repoId;
    if (!name || !repoId) return undefined;
    const rawPath = raw.fullpath ?? raw.path ?? name;
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    return {
        name,
        path,
        repoId,
        repoName: raw.repo_name ?? raw.repoName ?? "",
        isFile: raw.type !== "dir" && raw.type !== "folder",
        sizeBytes: typeof raw.size === "number" && raw.size >= 0 ? raw.size : null,
        modifiedAt: normalizeTime(raw.mtime),
    };
}

function normalizeFileDetail(raw: RawFileDetail, repoId: string, path: string): CloudFile | undefined {
    const name = raw.name?.trim() ?? raw.obj_name?.trim() ?? path.split("/").filter(Boolean).pop();
    if (!name) return undefined;
    const size = typeof raw.size === "number"
        ? raw.size
        : typeof raw.size === "string" && /^\d+$/.test(raw.size) ? Number(raw.size) : null;
    return {
        repoId,
        path,
        name,
        sizeBytes: size !== null && size >= 0 ? size : null,
        modifiedAt: normalizeTime(raw.mtime ?? raw.last_modified),
        permission: raw.permission ?? null,
        canPreview: raw.can_preview === true,
    };
}

function firstString(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim()) return value.trim();
    return undefined;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function apiUrlErrorMessage(status: number, body: unknown): string {
    const detail = firstString((body as {detail?: unknown} | undefined)?.detail);
    const message = firstString((body as {message?: unknown} | undefined)?.message);
    return detail ?? message ?? `HTTP ${status}`;
}

export class CloudClient {
    private readonly credentials?: LoginCredentials;
    private readonly jar = new Map<string, Map<string, string>>();
    private apiToken: string | undefined;
    private loggedIn = false;
    private loginPromise: Promise<void> | undefined;

    constructor(credentials?: LoginCredentials) {
        this.credentials = credentials;
    }

    private cookieHeader(hostname: string): string {
        return [...(this.jar.get(hostname)?.entries() ?? [])]
            .map(([name, value]) => `${name}=${value}`)
            .join("; ");
    }

    private collectCookies(hostname: string, response: Response): void {
        const domainJar = this.jar.get(hostname) ?? new Map<string, string>();
        this.jar.set(hostname, domainJar);
        for (const setCookie of response.headers.getSetCookie()) {
            const pair = cookieNameValue(setCookie);
            if (pair) domainJar.set(pair[0], pair[1]);
        }
    }

    private async sessionFetch(
        input: string | URL,
        init: RequestInit = {},
        redirectCount = 0,
    ): Promise<Response> {
        if (redirectCount > MAX_REDIRECTS) {
            throw new ThuError("UPSTREAM_ERROR", "清华云盘登录跳转次数过多");
        }
        const url = new URL(typeof input === "string" ? input : input.href);
        const headers = new Headers(init.headers);
        const cookie = this.cookieHeader(url.hostname);
        if (cookie) headers.set("cookie", cookie);
        headers.set("user-agent", "Mozilla/5.0 QingLing/0.2 CloudClient");
        headers.set("accept", init.method?.toUpperCase() === "POST"
            ? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
            : "application/json, text/html;q=0.9, */*;q=0.8");

        let response: Response;
        try {
            response = await fetch(url, {
                ...init,
                headers,
                redirect: "manual",
                signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            throw new ThuError("NETWORK_ERROR", `清华云盘网络请求失败：${(error as Error).message}`, error);
        }
        this.collectCookies(url.hostname, response);

        if (REDIRECT_STATUS.has(response.status)) {
            const location = response.headers.get("location");
            if (location) {
                const next = new URL(location, url).toString();
                const method = init.method?.toUpperCase() ?? "GET";
                const downgrade = response.status === 303 ||
                    ((response.status === 301 || response.status === 302) && method !== "GET");
                return this.sessionFetch(next, {
                    ...init,
                    method: downgrade ? "GET" : method,
                    body: downgrade ? undefined : init.body,
                }, redirectCount + 1);
            }
        }
        return response;
    }

    private async cloudRequest(
        path: string,
        init: RequestInit = {},
    ): Promise<Response> {
        const url = new URL(path, CLOUD_BASE);
        const headers = new Headers(init.headers);
        const cookie = this.cookieHeader(url.hostname);
        if (cookie) headers.set("cookie", cookie);
        if (this.apiToken) headers.set("authorization", `Token ${this.apiToken}`);
        headers.set("accept", "application/json");
        return fetch(url, {
            ...init,
            headers,
            redirect: "manual",
            signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    }

    private async doLogin(): Promise<void> {
        this.apiToken = undefined;
        this.jar.delete(new URL(CLOUD_BASE).hostname);
        let username: string;
        let password: string;
        try {
            username = this.credentials?.username ?? config.thu.username;
            password = this.credentials?.password ?? config.thu.password;
        } catch {
            throw new ThuError(
                "AUTH_FAILED",
                "尚未获得清华统一身份认证凭证。请先在清灵界面登录，或在本地 .env 中配置 THU_USERNAME / THU_PASSWORD。",
            );
        }

        const formResponse = await this.sessionFetch(SSO_ENTRY);
        const formHtml = await formResponse.text();
        const sm2PublicKey = /id="sm2publicKey"[^>]*>([0-9a-fA-F]+)</.exec(formHtml)?.[1];
        if (!sm2PublicKey) {
            throw new ThuError("UPSTREAM_ERROR", "清华云盘登录链未进入统一身份认证表单，或页面结构已变化");
        }

        const body = new URLSearchParams({
            i_user: username,
            i_pass: SM2_MAGIC_NUMBER + sm2.doEncrypt(
                password,
                sm2PublicKey,
            ),
            fingerPrint: resolveStableFingerprint(this.credentials?.fingerprint),
            fingerGenPrint: "",
            fingerGenPrint3: "",
            deviceName: "QingLing Desktop",
            i_captcha: "",
        }).toString();
        const loginResponse = await this.sessionFetch(ID_LOGIN_CHECK, {
            method: "POST",
            headers: {"content-type": "application/x-www-form-urlencoded"},
            body,
        });
        const loginHtml = await loginResponse.text();
        if (loginHtml.includes("二次认证")) {
            throw new ThuError(
                "AUTH_REQUIRED",
                "清华云盘登录触发了二次认证。请先在清灵中完成一次登录并信任当前设备，再重试。",
            );
        }

        // 统一认证登录成功页会给出 OAuth 回调链接；跟进后云盘 session 才真正建立。
        const callbackUrl = /href="([^"]+)"/.exec(loginHtml)?.[1];
        if (!callbackUrl || !loginHtml.includes("正在重定向")) {
            throw new ThuError("AUTH_FAILED", "清华统一身份认证登录失败（账号密码可能错误或页面结构变化）");
        }
        const callbackResponse = await this.sessionFetch(callbackUrl);
        if (callbackResponse.status >= 400) {
            throw new ThuError(
                "UPSTREAM_ERROR",
                `清华云盘 OAuth 回调失败（HTTP ${callbackResponse.status}）`,
            );
        }
        // 部分部署会返回 204/空体；只要不是错误就认为云盘网页会话已建立。
        await callbackResponse.arrayBuffer().catch(() => undefined);
        this.loggedIn = true;

        // 换 Token 是尽力而为：学校若关闭 session-token 功能，仍可用网页会话读 API。
        await this.ensureApiToken();
    }

    private csrfHeader(): Record<string, string> {
        const csrf = this.jar.get(new URL(CLOUD_BASE).hostname)?.get("csrftoken");
        return csrf ? {"x-csrftoken": csrf} : {};
    }

    private async ensureApiToken(): Promise<void> {
        const getResponse = await this.cloudRequest(TOKEN_BY_SESSION_URL, {
            headers: this.csrfHeader(),
        });
        if (getResponse.ok) {
            const parsed = parseJson(await getResponse.text()) as {token?: unknown} | undefined;
            const token = firstString(parsed?.token);
            if (token) {
                this.apiToken = token;
                return;
            }
        }

        const postResponse = await this.cloudRequest(TOKEN_BY_SESSION_URL, {
            method: "POST",
            headers: {
                ...this.csrfHeader(),
                "content-type": "application/json",
            },
            body: "{}",
        });
        if (postResponse.ok || postResponse.status === 409) {
            const parsed = parseJson(await postResponse.text()) as {token?: unknown} | undefined;
            const token = firstString(parsed?.token);
            if (token) {
                this.apiToken = token;
                return;
            }
        }
        // 不把 token 端点失败当成云盘功能失败：Seafile 只读 API 也可能接受网页会话。
    }

    async login(): Promise<void> {
        if (this.loggedIn) return;
        this.loginPromise ??= this.doLogin().finally(() => {
            this.loginPromise = undefined;
        });
        return this.loginPromise;
    }

    private async api<T>(path: string): Promise<T> {
        await this.login();
        let response = await this.cloudRequest(path);
        if (response.status === 401 || response.status === 403 || REDIRECT_STATUS.has(response.status)) {
            this.loggedIn = false;
            this.apiToken = undefined;
            this.jar.delete(new URL(CLOUD_BASE).hostname);
            await this.login();
            response = await this.cloudRequest(path);
        }

        const text = await response.text();
        const body = parseJson(text);
        if (!response.ok || body === undefined) {
            throw new ThuError(
                "UPSTREAM_ERROR",
                `清华云盘接口报错：${apiUrlErrorMessage(response.status, body)}`,
            );
        }
        return body as T;
    }

    async listLibraries(): Promise<CloudLibrary[]> {
        const body = await this.api<RawRepo[] | {repos?: RawRepo[]}>(`/api/v2.1/repos/`);
        const repos = Array.isArray(body) ? body : body.repos ?? [];
        return repos
            .map(normalizeRepo)
            .filter((item): item is CloudLibrary => item !== undefined)
            .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    }

    async getDirectory(repoId: string, path: string): Promise<CloudDirent[]> {
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        const body = await this.api<{
            dirent_list?: RawDirent[];
            dirents?: RawDirent[];
        } | RawDirent[]>(
            `/api/v2.1/repos/${encodeURIComponent(repoId)}/dir/?p=${encodeURIComponent(normalizedPath)}`,
        );
        const rawList = Array.isArray(body) ? body : body.dirent_list ?? body.dirents ?? [];
        return rawList
            .map((item) => normalizeDirent(item, normalizedPath))
            .filter((item): item is CloudDirent => item !== undefined)
            .sort((a, b) => (a.type === b.type
                ? a.name.localeCompare(b.name, "zh-Hans-CN")
                : a.type === "dir" ? -1 : 1));
    }

    async searchFiles(keyword: string): Promise<CloudSearchResult[]> {
        const body = await this.api<{results?: RawSearchResult[]} | RawSearchResult[]>(
            `/api2/search/?q=${encodeURIComponent(keyword)}` +
            "&search_repo=all&search_filename_only=true&per_page=100",
        );
        const rawList = Array.isArray(body) ? body : body.results ?? [];
        return rawList
            .map(normalizeSearchResult)
            .filter((item): item is CloudSearchResult => item !== undefined);
    }

    async getFileDetail(repoId: string, path: string): Promise<CloudFile> {
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        const body = await this.api<RawFileDetail>(
            `/api2/repos/${encodeURIComponent(repoId)}/file/detail/?p=${encodeURIComponent(normalizedPath)}`,
        );
        const file = normalizeFileDetail(body, repoId, normalizedPath);
        if (!file) throw new ThuError("UPSTREAM_ERROR", "清华云盘返回的文件信息不完整");
        return file;
    }

    async getFileDownloadUrl(repoId: string, path: string): Promise<string> {
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        const body = await this.api<string>(
            `/api2/repos/${encodeURIComponent(repoId)}/file/?p=${encodeURIComponent(normalizedPath)}&reuse=1`,
        );
        if (typeof body !== "string" || !/^https?:\/\//i.test(body)) {
            throw new ThuError("UPSTREAM_ERROR", "清华云盘没有返回有效的文件访问链接");
        }
        return body;
    }
}
