/**
 * TempImageStore 测试：put/peek/consume 生命周期、TTL 自清理。
 */
import {afterEach, describe, expect, it} from "vitest";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TempImageStore} from "../../src/utils/tempImageStore";

let dir = "";
afterEach(() => {
    if (dir) rmSync(dir, {recursive: true, force: true});
    dir = "";
});

const setup = (ttlMs = 60_000) => {
    dir = mkdtempSync(join(tmpdir(), "qingling-tmpimg-test-"));
    return new TempImageStore(dir, ttlMs);
};

describe("TempImageStore", () => {
    it("put 落盘并返回 token 与 URL；peek 取回文件信息且不注销", () => {
        const store = setup();
        const {token, url} = store.put(Buffer.from("png-bytes"), "image/png", "二维码.png");
        expect(url).toBe(`/api/temp-image/${token}`);
        const entry = store.peek(token)!;
        expect(entry.contentType).toBe("image/png");
        expect(entry.filename).toBe("二维码.png");
        expect(readFileSync(entry.path, "utf8")).toBe("png-bytes");
        expect(entry.path.startsWith(dir)).toBe(true);
        // peek 不消费：再看还在（serve 可重复，刷新历史也能看）
        expect(store.peek(token)).toBeDefined();
        expect(store.pendingCount).toBe(1);
    });

    it("consume 删文件并注销；重复 consume 返回 false", () => {
        const store = setup();
        const {token} = store.put(Buffer.from("x"), "image/jpeg", "a.jpg");
        const path = store.peek(token)!.path;
        expect(store.consume(token)).toBe(true);
        expect(existsSync(path)).toBe(false);
        expect(store.peek(token)).toBeUndefined();
        expect(store.consume(token)).toBe(false);
        expect(store.pendingCount).toBe(0);
    });

    it("未知 token：peek 取不到、consume false", () => {
        const store = setup();
        expect(store.peek("no-such-token")).toBeUndefined();
        expect(store.consume("no-such-token")).toBe(false);
    });

    it("TTL 到期自动删文件并注销（用户一直不点「已用完」的兜底）", async () => {
        const store = setup(30); // 30ms
        const {token} = store.put(Buffer.from("x"), "image/png", "a.png");
        const path = join(dir, `${token}.png`);
        expect(existsSync(path)).toBe(true);
        await new Promise((r) => setTimeout(r, 120));
        expect(store.pendingCount).toBe(0);
        expect(existsSync(path)).toBe(false);
    });

    it("consume 后 TTL 计时已取消，不会重复删除", async () => {
        const store = setup(60);
        const {token} = store.put(Buffer.from("x"), "image/png", "a.png");
        expect(store.consume(token)).toBe(true);
        await new Promise((r) => setTimeout(r, 120));
        expect(store.pendingCount).toBe(0); // 不炸、不复活
    });

    it("contentType 白名单映射扩展名，未知类型用 .img", () => {
        const store = setup();
        const {token} = store.put(Buffer.from("x"), "image/webp", "a.webp");
        expect(store.peek(token)!.path.endsWith(".webp")).toBe(true);
        const {token: t2} = store.put(Buffer.from("x"), "image/x-evil", "a");
        expect(store.peek(t2)!.path.endsWith(".img")).toBe(true);
    });
});
