/**
 * 环境变量读取。所有凭证只能从 .env 进入代码，绝不允许硬编码。
 * 复制 .env.example 为 .env 并填入真实值（.env 已在 .gitignore 中）。
 */
import "dotenv/config";

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
            return required("THU_FINGERPRINT");
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
    },
};
