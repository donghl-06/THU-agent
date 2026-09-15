/**
 * 网络学堂（thu-learn-lib）错误归一化。
 *
 * thu-learn-lib 抛 ApiError（reason 是 FailReason 枚举），Skill 层只面对 ThuError，
 * 与 @thu-info/lib 的错误体系（client/errors.ts）保持同一套码。
 */
import {ApiError, FailReason} from "thu-learn-lib";
import {ThuError} from "../errors";

/** 把 thu-learn-lib 的异常归一化为 ThuError */
export function normalizeLearnError(e: unknown): ThuError {
    if (e instanceof ThuError) {
        return e;
    }
    if (e instanceof ApiError) {
        switch (e.reason) {
            case FailReason.DOUBLE_AUTH:
                return new ThuError(
                    "AUTH_REQUIRED",
                    "账号开启了二次认证且本设备未信任。请先在清灵里完成一次登录（会自动信任本设备），再重试网络学堂操作。",
                    e,
                );
            case FailReason.BAD_CREDENTIAL:
                return new ThuError("AUTH_FAILED", "网络学堂登录失败：账号或密码错误。", e);
            case FailReason.NO_CREDENTIAL:
                return new ThuError("AUTH_FAILED", "缺少登录凭证（THU_USERNAME/THU_PASSWORD 或网页登录）。", e);
            case FailReason.CAPTCHA_REQUIRED:
                return new ThuError(
                    "AUTH_REQUIRED",
                    "网络学堂登录触发了验证码（通常是短时间内登录太频繁）。请稍后再试，或先在浏览器登录一次网络学堂。",
                    e,
                );
            case FailReason.NOT_LOGGED_IN:
                return new ThuError("AUTH_REQUIRED", "网络学堂登录态失效且自动重登失败，请重试。", e);
            case FailReason.OPERATION_FAILED: {
                // 提交作业等业务失败：extra 里带服务端的 msg
                const extra = e.extra as {msg?: unknown} | undefined;
                const msg = typeof extra?.msg === "string" && extra.msg ? extra.msg : "操作被网络学堂拒绝";
                return new ThuError("UPSTREAM_ERROR", `网络学堂操作失败：${msg}`, e);
            }
            case FailReason.ERROR_FETCH_FROM_ID:
            case FailReason.ERROR_ROAMING:
            case FailReason.UNEXPECTED_STATUS:
            case FailReason.INVALID_RESPONSE:
            case FailReason.NOT_IMPLEMENTED:
            default:
                return new ThuError("UPSTREAM_ERROR", `网络学堂响应异常（${e.reason}）。`, e);
        }
    }
    // undici 全局 fetch 的网络错误：TypeError("fetch failed")，cause 带 ECONNRESET 等
    if (e instanceof TypeError && e.message.includes("fetch")) {
        const code = (e.cause as {code?: string} | undefined)?.code ?? "";
        if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
            return new ThuError("TIMEOUT", "请求网络学堂超时，稍后重试通常有效。", e);
        }
        return new ThuError("NETWORK_ERROR", `网络请求失败（${code || "未知原因"}），请检查网络后重试。`, e);
    }
    if (e instanceof Error) {
        return new ThuError("UNKNOWN", e.message, e);
    }
    return new ThuError("UNKNOWN", String(e), e);
}
