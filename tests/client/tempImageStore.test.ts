/**
 * TempImageStore 测试：put/take 一次性语义、TTL 自清理、serve 后删除。
 */
import {afterEach, describe, expect, it} from "vitest";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {removeServedImage, TempImageStore} from "../../src/utils/tempImageStore";

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
    it("put 落盘并返回 token 与 URL；take 取回文件信息", () => {
        const store = setup();
        const {token, url} = store.put(Buffer.from("png-bytes"), "image/png", "二维码.png");
        expect(url).toBe(`/api/temp-image/${token}`);
        const entry = store.take(token)!;
        expect(entry.contentType).toBe("image/png");
        expect(entry.filename).toBe("二维码.png");
        expect(readFileSync(entry.path, "utf8")).toBe("png-bytes");
        expect(entry.path.startsWith(dir)).toBe(true);
    });

    it("take 是一次性的：取走后 token 立即失效", () => {
        const store = setup();
        const {token} = store.put(Buffer.from("x"), "image/jpeg", "a.jpg");
        expect(store.take(token)).toBeDefined();
        expect(store.take(token)).toBeUndefined();
        expect(store.pendingCount).toBe(0);
    });

    it("未知 token 取不到", () => {
        const store = setup();
        expect(store.take("no-such-token")).toBeUndefined();
    });

    it("TTL 到期自动删文件并注销", async () => {
        const store = setup(30); // 30ms
        const {token} = store.put(Buffer.from("x"), "image/png", "a.png");
        const path = join(dir, `${token}.png`);
        expect(existsSync(path)).toBe(true);
        await new Promise((r) => setTimeout(r, 120));
        expect(store.pendingCount).toBe(0);
        expect(existsSync(path)).toBe(false);
    });

    it("serve 后 removeServedImage 删除文件；删两次不炸", () => {
        const store = setup();
        const {token} = store.put(Buffer.from("x"), "image/png", "a.png");
        const entry = store.take(token)!;
        removeServedImage(entry.path);
        expect(existsSync(entry.path)).toBe(false);
        removeServedImage(entry.path); // 幂等
    });

    it("contentType 白名单映射扩展名，未知类型用 .img", () => {
        const store = setup();
        const {token} = store.put(Buffer.from("x"), "image/webp", "a.webp");
        expect(store.take(token)!.path.endsWith(".webp")).toBe(true);
        const {token: t2} = store.put(Buffer.from("x"), "image/x-evil", "a");
        expect(store.take(t2)!.path.endsWith(".img")).toBe(true);
    });
});
