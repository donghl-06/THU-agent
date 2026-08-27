/**
 * Step 2 验证脚本：用 .env 里的清华账号真实登录（支持二次认证 2FA），
 * 并调用 getUserInfo() 确认能拿到个人信息（间接证明登录态有效）。
 *
 * 运行：pnpm step2
 * 注意：必须带 OPENSSL_CONF 环境变量（见 package.json），
 *      否则 Node 的 OpenSSL 3 会拒绝清华服务器的旧版 TLS 重协商。
 *      日志中绝不打印密码。
 */
import * as readline from "node:readline/promises";
import {InfoHelper} from "@thu-info/lib";
import {config} from "../src/config/env";

const rl = readline.createInterface({input: process.stdin, output: process.stdout});

const helper = new InfoHelper();

// 账号开启了二次认证时，库会通过这两个 hook 向我们"回调提问"：
helper.twoFactorMethodHook = async (hasWeChatBool, phone, hasTotp) => {
    console.log("\n账号需要二次认证，可用方式：");
    if (hasTotp) console.log("  - totp   （验证器 App 动态码，推荐）");
    if (phone) console.log(`  - mobile （短信验证码，发送至 ${phone}）`);
    if (hasWeChatBool) console.log("  - wechat （微信）");
    const choice = await rl.question("请选择方式（直接回车默认 totp）：");
    if (choice === "mobile" || choice === "wechat") return choice;
    return "totp";
};

helper.twoFactorAuthHook = async () => {
    return rl.question("请输入验证码：");
};

try {
    console.log("正在登录……");
    await helper.login({
        userId: config.thu.username,
        password: config.thu.password,
    });
    console.log("登录成功。");

    console.log("正在获取用户信息……");
    const userInfo = await helper.getUserInfo();
    console.log("用户信息：", userInfo);

    console.log("\nStep 2 通过：登录 + getUserInfo() 成功。");
    console.log("下一步（Step 3）：scripts/step3-schedule.ts 拉取真实课表。");
} finally {
    rl.close();
}
