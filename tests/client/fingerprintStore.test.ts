import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {resolveStableFingerprint} from "../../src/client/fingerprintStore";

const originalOverride = process.env.THU_FINGERPRINT;
let directory: string | undefined;

afterEach(() => {
    if (directory) rmSync(directory, {recursive: true, force: true});
    directory = undefined;
    if (originalOverride === undefined) delete process.env.THU_FINGERPRINT;
    else process.env.THU_FINGERPRINT = originalOverride;
});

describe("stable device fingerprint", () => {
    it("creates one fingerprint and reuses it for later calls", () => {
        directory = mkdtempSync(join(tmpdir(), "qingling-fingerprint-"));
        const file = join(directory, "device.json");
        process.env.THU_FINGERPRINT = "";

        const first = resolveStableFingerprint(undefined, file);
        const second = resolveStableFingerprint(undefined, file);

        expect(first).toMatch(/^[0-9a-f]{32}$/);
        expect(second).toBe(first);
        expect(JSON.parse(readFileSync(file, "utf8")).fingerprint).toBe(first);
    });

    it("lets an explicit developer override win without touching the shared file", () => {
        directory = mkdtempSync(join(tmpdir(), "qingling-fingerprint-"));
        const file = join(directory, "device.json");
        const explicit = "0123456789abcdef0123456789abcdef";

        expect(resolveStableFingerprint(explicit, file)).toBe(explicit);
        expect(resolveStableFingerprint(explicit.toUpperCase(), file)).toBe(explicit);
    });

    it("rejects malformed overrides and stored files instead of silently replacing them", () => {
        directory = mkdtempSync(join(tmpdir(), "qingling-fingerprint-"));
        const file = join(directory, "device.json");
        process.env.THU_FINGERPRINT = "";

        expect(() => resolveStableFingerprint("not-hex", file)).toThrow(
            /THU_FINGERPRINT 必须是 32 位十六进制字符串/,
        );

        writeFileSync(file, "{\"fingerprint\":\"oops\"}\n");
        expect(() => resolveStableFingerprint(undefined, file)).toThrow(/设备指纹文件格式无效/);
    });
});
