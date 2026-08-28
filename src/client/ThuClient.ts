/**
 * ThuClient —— Agent 项目与 @thu-info/lib 之间的统一适配层（plan4ai.md 第 4.2 节）。
 *
 * 职责：
 *   - InfoHelper 生命周期与登录会话管理
 *   - 凭证 / 指纹 / 设备信任（见 auth.ts）
 *   - 网络错误的有限重试（清华服务器偶发超时，官方 README 建议重试）
 *   - 错误归一化（见 errors.ts）
 *
 * 非职责：业务参数校验、输出裁剪 —— 那是 Skill 层的事。
 *
 * 注意：只在确认可用后才添加新的 API 包装方法，不提前堆方法。
 */
import {InfoHelper} from "@thu-info/lib";
import {config} from "../config/env";
import {setupAuth, type TwoFactorHooks} from "./auth";
import {normalizeError, ThuError} from "./errors";

/** login() 遇到网络类错误时的最大尝试次数（含首次） */
const LOGIN_MAX_ATTEMPTS = 3;

export class ThuClient {
    private readonly helper: InfoHelper;
    private loggedIn = false;

    constructor(hooks: TwoFactorHooks = {}) {
        this.helper = new InfoHelper();
        setupAuth(this.helper, hooks);
    }

    /**
     * 登录（幂等）。网络类错误自动重试，认证类错误直接抛出。
     */
    async login(): Promise<void> {
        if (this.loggedIn) return;
        let lastError: ThuError | undefined;
        for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt++) {
            try {
                await this.helper.login({
                    userId: config.thu.username,
                    password: config.thu.password,
                });
                this.loggedIn = true;
                return;
            } catch (e) {
                lastError = normalizeError(e);
                if (lastError.code !== "NETWORK_ERROR" && lastError.code !== "TIMEOUT") {
                    throw lastError; // 认证/服务端错误重试无意义
                }
            }
        }
        throw lastError;
    }

    /** 内部统一调用入口：确保已登录 + 错误归一化 */
    private async call<T>(fn: () => Promise<T>): Promise<T> {
        await this.login();
        try {
            return await fn();
        } catch (e) {
            throw normalizeError(e);
        }
    }

    /** 获取课表。nextSemesterIndex 省略时查当前学期 */
    async getSchedule(nextSemesterIndex?: number): Promise<ReturnType<InfoHelper["getSchedule"]>> {
        return this.call(() => this.helper.getSchedule(nextSemesterIndex));
    }

    /** 获取当前用户基本信息（姓名、邮箱名） */
    async getUserInfo(): Promise<ReturnType<InfoHelper["getUserInfo"]>> {
        return this.call(() => this.helper.getUserInfo());
    }
}
