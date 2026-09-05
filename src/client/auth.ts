/**
 * ThuClient 认证装配（plan4ai.md 第 4 节：authentication / credential handling）。
 *
 * 把指纹、设备信任、二次认证回调统一收口到这里，
 * Skill 和上层永远不需要接触这些细节。
 */
import type {InfoHelper} from "@thu-info/lib";
import {resolveStableFingerprint} from "./fingerprintStore";

/**
 * 二次认证回调。账号触发 2FA 时库会调用它们向用户提问。
 * 交互式场景（CLI 或 Web UI）传入回调实现；
 * 未传回调时，库会抛出可识别的认证错误。
 */
export interface TwoFactorHooks {
    twoFactorMethodHook?: InfoHelper["twoFactorMethodHook"];
    twoFactorAuthHook?: InfoHelper["twoFactorAuthHook"];
    /** 登录成功通知（Web UI 用于关闭认证窗口）。 */
    onLoginSuccess?: () => void;
}

export interface LoginCredentials {
    username: string;
    password: string;
    fingerprint?: string;
}

export function setupAuth(
    helper: InfoHelper,
    hooks: TwoFactorHooks = {},
    fingerprint?: string,
): void {
    // 固定设备指纹 + 信任此设备：首次信任后同指纹登录跳过 2FA。
    // 会在账号「多因子认证」里登记名为 QingLing Desktop 的信任设备。
    helper.fingerprint = resolveStableFingerprint(fingerprint);
    helper.trustFingerprintHook = async () => true;
    helper.trustFingerprintNameHook = async () => "QingLing Desktop";
    helper.twoFactorAuthLimitHook = async () => {
        throw new Error(
            "信任设备数量已达上限，请到 https://id.tsinghua.edu.cn/ 的「多因子认证」页面删除旧设备。",
        );
    };

    if (hooks.twoFactorMethodHook) helper.twoFactorMethodHook = hooks.twoFactorMethodHook;
    if (hooks.twoFactorAuthHook) helper.twoFactorAuthHook = hooks.twoFactorAuthHook;
}
