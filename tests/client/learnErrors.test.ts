/**
 * 网络学堂错误归一化测试（无网络）。
 *
 * thu-learn-lib 抛 ApiError(FailReason)，Skill 层只应看到 ThuError 的那套码。
 */
import {describe, expect, it} from "vitest";
import {ApiError, FailReason} from "thu-learn-lib";
import {normalizeLearnError} from "../../src/client/learn/errors";
import {ThuError} from "../../src/client/errors";

describe("normalizeLearnError（thu-learn-lib → ThuError）", () => {
    it("DOUBLE_AUTH 映射为 AUTH_REQUIRED", () => {
        const err = normalizeLearnError(new ApiError(FailReason.DOUBLE_AUTH));
        expect(err).toBeInstanceOf(ThuError);
        expect(err.code).toBe("AUTH_REQUIRED");
    });

    it("BAD_CREDENTIAL / NO_CREDENTIAL 映射为 AUTH_FAILED", () => {
        expect(normalizeLearnError(new ApiError(FailReason.BAD_CREDENTIAL)).code).toBe("AUTH_FAILED");
        expect(normalizeLearnError(new ApiError(FailReason.NO_CREDENTIAL)).code).toBe("AUTH_FAILED");
    });

    it("OPERATION_FAILED 带出卖方的 msg", () => {
        const err = normalizeLearnError(new ApiError(FailReason.OPERATION_FAILED, {msg: "已超过截止时间"}));
        expect(err.code).toBe("UPSTREAM_ERROR");
        expect(err.message).toContain("已超过截止时间");
    });

    it("INVALID_RESPONSE / ERROR_ROAMING 映射为 UPSTREAM_ERROR", () => {
        expect(normalizeLearnError(new ApiError(FailReason.INVALID_RESPONSE)).code).toBe("UPSTREAM_ERROR");
        expect(normalizeLearnError(new ApiError(FailReason.ERROR_ROAMING)).code).toBe("UPSTREAM_ERROR");
    });

    it("undici fetch 网络错误映射为 NETWORK_ERROR / TIMEOUT", () => {
        const fetchFailed = new TypeError("fetch failed");
        expect(normalizeLearnError(fetchFailed).code).toBe("NETWORK_ERROR");
        const timeout = new TypeError("fetch failed", {cause: {code: "ETIMEDOUT"}});
        expect(normalizeLearnError(timeout).code).toBe("TIMEOUT");
    });

    it("ThuError 原样透传，未知错误兜底 UNKNOWN", () => {
        const thu = new ThuError("MAINTENANCE", "维护中");
        expect(normalizeLearnError(thu)).toBe(thu);
        expect(normalizeLearnError(new Error("其他")).code).toBe("UNKNOWN");
        expect(normalizeLearnError("字符串错误").code).toBe("UNKNOWN");
    });
});
