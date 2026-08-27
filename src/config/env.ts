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
    },
    deepseek: {
        get apiKey() {
            return required("DEEPSEEK_API_KEY");
        },
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    },
};
