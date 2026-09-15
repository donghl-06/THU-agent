/**
 * 环境变量读取。所有凭证只能从 .env 进入代码，绝不允许硬编码。
 * 复制 .env.example 为 .env 并填入真实值（.env 已在 .gitignore 中）。
 */
import "dotenv/config";
import {resolveStableFingerprint} from "../client/fingerprintStore";

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `缺少环境变量 ${name}。请复制 .env.example 为 .env 并填入真实值。`,
        );
    }
    return value;
}

export const config = {
    thu: {
        get username() {
            return required("THU_USERNAME");
        },
        get password() {
            return required("THU_PASSWORD");
        },
        /** 固定设备指纹（32 位 hex）。配合信任设备可跳过每次的二次认证 */
        get fingerprint() {
            return resolveStableFingerprint();
        },
    },
    llm: {
        get apiKey() {
            return required("LLM_API_KEY");
        },
        /** OpenAI 兼容接口地址。默认 Kimi for Coding 端点（sk-kimi- 开头的 key） */
        get baseUrl() {
            return process.env.LLM_BASE_URL ?? "https://api.kimi.com/coding/v1";
        },
        /** 模型名，如 k3-256k（以平台控制台的模型 ID 为准） */
        get model() {
            return process.env.LLM_MODEL ?? "k3-256k";
        },
        /**
         * 端点是否支持图片输入（vision）。k3-256k 已实测支持（Step 20 探测），
         * 默认开；换不支持 vision 的模型时设 LLM_VISION=0 关掉前端图片入口。
         */
        get vision() {
            return process.env.LLM_VISION !== "0";
        },
        /** 输入/输出单价（元/百万 token），可选；两个都配了才显示估算费用 */
        get priceIn() {
            const v = Number(process.env.LLM_PRICE_IN);
            return Number.isFinite(v) && v > 0 ? v : undefined;
        },
        get priceOut() {
            const v = Number(process.env.LLM_PRICE_OUT);
            return Number.isFinite(v) && v > 0 ? v : undefined;
        },
    },
    /** Web UI 访问口令（局域网开放时防同网他人使用）。未配置 = 不启用鉴权 */
    ui: {
        get token(): string {
            return process.env.UI_TOKEN ?? "";
        },
    },
    /** 校历：学期第一教学周的周一日期（YYYY-MM-DD）。配置后 system prompt 注入教学周 */
    calendar: {
        get semesterStart(): string | undefined {
            const v = process.env.SEMESTER_START;
            return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
        },
    },
    /** 超级鹰打码平台（预约滑块验证码用，单次约 0.01 元）。不预约可不填 */
    chaojiying: {
        get user() {
            return process.env.CJY_USER ?? "";
        },
        get password() {
            return process.env.CJY_PASSWORD ?? "";
        },
        get softId() {
            return process.env.CJY_SOFT_ID ?? "";
        },
        get configured() {
            return Boolean(process.env.CJY_USER && process.env.CJY_PASSWORD && process.env.CJY_SOFT_ID);
        },
    },
    /** 清华邮箱（Coremail）IMAP/SMTP。用「客户端授权码」而非邮箱密码（网页版邮箱设置里生成）。
     *  未配置时 username/password 为 undefined，邮件技能报 AUTH_FAILED 提示配置 */
    email: {
        get username(): string | undefined {
            return process.env.THU_EMAIL_USERNAME || undefined;
        },
        /** 客户端授权码 */
        get password(): string | undefined {
            return process.env.THU_EMAIL_PASSWORD || undefined;
        },
        get imapHost() {
            return process.env.THU_EMAIL_IMAP_HOST ?? "imap.tsinghua.edu.cn";
        },
        get imapPort() {
            return Number(process.env.THU_EMAIL_IMAP_PORT ?? 993);
        },
        get smtpHost() {
            return process.env.THU_EMAIL_SMTP_HOST ?? "smtp.tsinghua.edu.cn";
        },
        get smtpPort() {
            return Number(process.env.THU_EMAIL_SMTP_PORT ?? 465);
        },
        get configured() {
            return Boolean(this.username && this.password);
        },
    },
};
