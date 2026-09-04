/** 独立 MCP 包的首次登录与二次认证入口。 */
import {existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {createInterface} from "node:readline/promises";
import {stdin, stdout} from "node:process";

const scriptDirectory = dirname(process.argv[1] ?? process.cwd());
const candidateRoots = [
    scriptDirectory,
    join(scriptDirectory, ".."),
    join(scriptDirectory, "..", ".."),
    process.cwd(),
];
const envPath = candidateRoots.map((root) => join(root, ".env")).find((path) => existsSync(path));
if (envPath) process.env.DOTENV_CONFIG_PATH ??= envPath;
const opensslPath = candidateRoots.map((root) => join(root, "openssl.cnf")).find((path) => existsSync(path));
if (opensslPath) process.env.OPENSSL_CONF ??= opensslPath;

type AuthMethod = "totp" | "mobile" | "wechat";

async function main(): Promise<void> {
    if (!envPath) {
        throw new Error("找不到 .env。请先把 .env.example 复制为 .env，并填写清华账号和设备指纹。");
    }
    const prompt = createInterface({input: stdin, output: stdout});
    try {
        const {ThuClient} = await import("../src/client/ThuClient");
        const client = new ThuClient({
            twoFactorMethodHook: async (hasWeChat, phone, hasTotp) => {
                const choices: {method: AuthMethod; label: string}[] = [];
                if (hasTotp) choices.push({method: "totp", label: "动态口令（TOTP）"});
                if (phone) {
                    const digits = phone.replace(/\D/g, "");
                    const masked = digits.length >= 4 ? `尾号 ${digits.slice(-4)}` : "已绑定手机号";
                    choices.push({method: "mobile", label: `手机短信（${masked}）`});
                }
                if (hasWeChat) choices.push({method: "wechat", label: "微信验证码"});
                if (choices.length === 0) return undefined;
                console.log("\n账号需要二次认证，请选择认证方式：");
                choices.forEach((choice, index) => console.log(`${index + 1}. ${choice.label}`));
                for (;;) {
                    const answer = (await prompt.question(`请输入 1-${choices.length}：`)).trim();
                    const selected = choices[Number(answer) - 1];
                    if (selected) return selected.method;
                    console.log("输入无效，请重新选择。");
                }
            },
            twoFactorAuthHook: async () => {
                const code = (await prompt.question("请输入收到的验证码或动态口令：")).trim();
                return code || undefined;
            },
        });
        console.log("正在登录清华校园服务……");
        await client.login();
        console.log("\n登录成功，当前设备已完成认证。现在可以在 Codex 等 Agent 中使用清华校园工具。");
    } finally {
        prompt.close();
    }
}

void main().catch((error) => {
    console.error(`\n登录失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
