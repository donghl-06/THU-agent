/**
 * ThuClient 统一错误类型（plan4ai.md 第 4 节：error normalization）。
 *
 * Skill 层和 Harness 层只面对 ThuError，不需要认识 @thu-info/lib 的错误体系。
 */
import {
    IdAuthError,
    LibError,
    LoginError,
    ResponseStatusError,
} from "@thu-info/lib/dist/utils/error";

export type ThuErrorCode =
    | "AUTH_REQUIRED" // 需要二次认证等人工介入
    | "AUTH_FAILED" // 登录失败（密码错误等）
    | "NETWORK_ERROR" // 网络不通（清华服务器偶发，重试通常有效）
    | "TIMEOUT" // 请求超时
    | "UPSTREAM_ERROR" // 清华服务端返回异常状态
    | "LIB_ERROR" // 库抛出的其他业务错误（保留原始 message）
    | "UNKNOWN";

export class ThuError extends Error {
    constructor(
        public readonly code: ThuErrorCode,
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = "ThuError";
    }
}

/** 把任意底层异常归一化为 ThuError */
export function normalizeError(e: unknown): ThuError {
    if (e instanceof ThuError) {
        return e;
    }
    if (e instanceof LoginError || e instanceof IdAuthError) {
        // 库在"需要 2FA 但没有回调"时也抛 LoginError
        if (e.message.includes("2FA") || e.message.includes("二次认证")) {
            return new ThuError(
                "AUTH_REQUIRED",
                "账号开启了二次认证且当前会话未信任。请先运行 pnpm step2 完成一次交互式登录。",
                e,
            );
        }
        return new ThuError("AUTH_FAILED", `登录失败：${e.message}`, e);
    }
    if (e instanceof ResponseStatusError) {
        return new ThuError("UPSTREAM_ERROR", `清华服务端响应异常：${e.message}`, e);
    }
    if (e instanceof LibError) {
        return new ThuError("LIB_ERROR", e.message, e);
    }
    // node-fetch 的网络错误：{ type: 'system', code: 'ETIMEDOUT' | 'ECONNRESET' ... }
    if (e instanceof Error && e.name === "FetchError") {
        const code = (e as {code?: string}).code ?? "";
        if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
            return new ThuError("TIMEOUT", "请求清华服务器超时，稍后重试通常有效。", e);
        }
        return new ThuError("NETWORK_ERROR", `网络请求失败（${code || "未知原因"}），请检查网络后重试。`, e);
    }
    if (e instanceof Error) {
        return new ThuError("UNKNOWN", e.message, e);
    }
    return new ThuError("UNKNOWN", String(e), e);
}
