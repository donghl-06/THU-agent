/**
 * Info 登录会话持久化：把 @thu-info/lib 的全局 cookie jar 快照落盘/恢复。
 *
 * 解决"服务重启后要重新走清华登录（可能还有 2FA）"的问题：启动时灌回快照
 * 即视为已登录；cookie 过期后 skill 报登录失效，用户重新登录一次自然续上。
 *
 * 安全：文件内容是会话票据（等同浏览器 cookie），放在 gitignore 的 data/ 下，
 * 权限收紧为 0600；logout 时立即清除。
 */
import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {clearCookies, cookies, setCookie} from "@thu-info/lib/dist/utils/network";

export class AuthSessionStore {
    constructor(private readonly file: string) {}

    /** 存档存在且非空（不代表 cookie 一定仍有效，失效时走正常重新登录兜底） */
    has(): boolean {
        try {
            const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
            return typeof raw === "object" && Object.keys(raw).length > 0;
        } catch {
            return false;
        }
    }

    /** 把当前 cookie jar 快照落盘 */
    save(): void {
        try {
            mkdirSync(dirname(this.file), {recursive: true});
            writeFileSync(this.file, JSON.stringify(cookies));
            chmodSync(this.file, 0o600);
        } catch {
            // 持久化失败不影响内存中的登录态
        }
    }

    /** 把快照灌回 cookie jar；有有效存档返回 true */
    restore(): boolean {
        try {
            if (!existsSync(this.file)) return false;
            const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
            const entries = Object.entries(raw).filter(([k, v]) => k && typeof v === "string");
            if (entries.length === 0) return false;
            for (const [key, value] of entries) setCookie(key, value);
            return true;
        } catch {
            return false;
        }
    }

    /** 登出：清 jar + 删存档 */
    clear(): void {
        try {
            clearCookies();
        } catch { /* jar 已空 */ }
        try {
            rmSync(this.file, {force: true});
        } catch { /* 文件已不存在 */ }
    }
}
