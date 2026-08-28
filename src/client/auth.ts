/**
 * ThuClient 认证装配（plan4ai.md 第 4 节：authentication / credential handling）。
 *
 * 把指纹、设备信任、二次认证回调统一收口到这里，
 * Skill 和上层永远不需要接触这些细节。
 */
import type {InfoHelper} from "@thu-info/lib";
import {config} from "../config/env";

/**
 * 二次认证回调。账号触发 2FA 时库会调用它们向用户提问。
 * 交互式场景（CLI 脚本）传入 readline 实现；
 * 非交互场景（未来的 Harness）不传，库会抛出可识别的错误。
 */
export interface TwoFactorHooks {
    twoFactorMethodHook?: InfoHelper["twoFactorMethodHook"];
    twoFactorAuthHook?: InfoHelper["twoFactorAuthHook"];
}

export function setupAuth(helper: InfoHelper, hooks: TwoFactorHooks = {}): void {
    // 固定设备指纹 + 信任此设备：首次信任后同指纹登录跳过 2FA。
    // 会在账号「多因子认证」里登记名为 thu-assistant-dev 的信任设备。
    helper.fingerprint = config.thu.fingerprint;
    helper.trustFingerprintHook = async () => true;
    helper.trustFingerprintNameHook = async () => "thu-assistant-dev";
    helper.twoFactorAuthLimitHook = async () => {
        throw new Error(
            "信任设备数量已达上限，请到 https://id.tsinghua.edu.cn/ 的「多因子认证」页面删除旧设备。",
        );
    };

    if (hooks.twoFactorMethodHook) helper.twoFactorMethodHook = hooks.twoFactorMethodHook;
    if (hooks.twoFactorAuthHook) helper.twoFactorAuthHook = hooks.twoFactorAuthHook;
}
