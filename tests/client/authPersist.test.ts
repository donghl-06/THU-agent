/**
 * 登录会话持久化单测：直接操作 @thu-info/lib 的真实全局 cookie jar，
 * 验证 save → clear → restore 的往返与文件清理。不碰网络。
 */
import {describe, expect, it} from "vitest";
import {existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {clearCookies, cookies, setCookie} from "@thu-info/lib/dist/utils/network";
import {AuthSessionStore} from "../../src/client/authPersist";

const storeFile = () => join(tmpdir(), `thu-auth-test-${randomUUID().slice(0, 8)}.json`);

describe("AuthSessionStore", () => {
    it("save → clear → restore 往返恢复 jar 内容", () => {
        const file = storeFile();
        const store = new AuthSessionStore(file);
        clearCookies();
        setCookie("SFSESSION", "abc123");
        setCookie("webvpn_login", "xyz");
        store.save();

        clearCookies(); // 模拟进程重启后 jar 为空
        expect(Object.keys(cookies)).toHaveLength(0);
        expect(store.has()).toBe(true);

        expect(store.restore()).toBe(true);
        expect(cookies.SFSESSION).toBe("abc123");
        expect(cookies.webvpn_login).toBe("xyz");
        if (existsSync(file)) require("node:fs").rmSync(file);
        clearCookies();
    });

    it("clear 清 jar 且删存档文件", () => {
        const file = storeFile();
        const store = new AuthSessionStore(file);
        clearCookies();
        setCookie("k", "v");
        store.save();
        expect(existsSync(file)).toBe(true);

        store.clear();
        expect(existsSync(file)).toBe(false);
        expect(Object.keys(cookies)).toHaveLength(0);
        expect(store.has()).toBe(false);
    });

    it("无存档时 has/restore 返回 false", () => {
        const store = new AuthSessionStore(storeFile());
        expect(store.has()).toBe(false);
        expect(store.restore()).toBe(false);
    });

    it("损坏的存档文件：has/restore 安全返回 false", () => {
        const file = storeFile();
        require("node:fs").writeFileSync(file, "{not json");
        const store = new AuthSessionStore(file);
        expect(store.has()).toBe(false);
        expect(store.restore()).toBe(false);
        require("node:fs").rmSync(file, {force: true});
    });
});
