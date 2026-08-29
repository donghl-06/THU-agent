/**
 * resolveCaptchaSolver 装配决策的回归测试。
 * 历史 bug：createAllSkills 算出了超级鹰求解器却传了 opts.captchaSolver 原值，
 * 导致 .env 配好了也报 CAPTCHA_REQUIRED（2026-08-29 实测踩中）。
 */
import {afterEach, describe, expect, it} from "vitest";
import {resolveCaptchaSolver} from "../../src/skills";

const KEYS = ["CJY_USER", "CJY_PASSWORD", "CJY_SOFT_ID"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe("resolveCaptchaSolver", () => {
    it(".env 配齐 CJY_* 时自动返回超级鹰求解器", () => {
        process.env.CJY_USER = "u";
        process.env.CJY_PASSWORD = "p";
        process.env.CJY_SOFT_ID = "s";
        expect(resolveCaptchaSolver()).toBeTypeOf("function");
    });

    it("缺任意一项时不装配（预约会报 CAPTCHA_REQUIRED）", () => {
        process.env.CJY_USER = "u";
        process.env.CJY_PASSWORD = "p";
        delete process.env.CJY_SOFT_ID;
        expect(resolveCaptchaSolver()).toBeUndefined();
    });

    it("显式传入的求解器优先于环境配置", () => {
        process.env.CJY_USER = "u";
        process.env.CJY_PASSWORD = "p";
        process.env.CJY_SOFT_ID = "s";
        const mine = resolveCaptchaSolver(); // 超级鹰实例
        const custom: NonNullable<ReturnType<typeof resolveCaptchaSolver>> = async () => 42;
        expect(resolveCaptchaSolver(custom)).toBe(custom);
        expect(resolveCaptchaSolver(custom)).not.toBe(mine);
    });
});
