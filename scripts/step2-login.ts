/**
 * Step 2 验证脚本：真实登录（支持交互式二次认证），
 * 并调用 getUserInfo() 确认登录态有效。
 *
 * 运行：pnpm step2
 * 说明：交互逻辑（readline 提问）属于脚本层；
 *      登录/指纹/信任设备由 ThuClient 统一负责。
 */
import * as readline from "node:readline/promises";
import {ThuClient} from "../src/client/ThuClient";

const rl = readline.createInterface({input: process.stdin, output: process.stdout});

const client = new ThuClient({
    twoFactorMethodHook: async (hasWeChatBool, phone, hasTotp) => {
        console.log("\n账号需要二次认证，可用方式：");
        if (hasTotp) console.log("  - totp   （验证器 App 动态码，推荐）");
        if (phone) console.log(`  - mobile （短信验证码，发送至 ${phone}）`);
        if (hasWeChatBool) console.log("  - wechat （微信）");
        const choice = await rl.question("请选择方式（直接回车默认 totp）：");
        if (choice === "mobile" || choice === "wechat") return choice;
        return "totp";
    },
    twoFactorAuthHook: async () => rl.question("请输入验证码："),
});

try {
    console.log("正在登录……");
    await client.login();
    console.log("登录成功。");

    console.log("正在获取用户信息……");
    const userInfo = await client.getUserInfo();
    console.log("用户信息：", userInfo);

    console.log("\nStep 2 通过：ThuClient 登录 + getUserInfo() 成功。");
} finally {
    rl.close();
}
