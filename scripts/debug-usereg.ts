/**
 * 诊断校园网（usereg）登录链路。
 *
 * 背景：lib 用 emailName（邮箱名）作为 usereg 的 LoginForm[username]，
 * 本项目最初用学号直传——两者不一定相同（研究生/老账号常见差异）。
 * 本脚本用 .env 凭证分别以"学号"和"emailName"各试一次完整登录，
 * 打印每步中间量（凭证脱敏），定位"用户名或密码错误"到底卡在哪。
 *
 * 运行：OPENSSL_CONF=${PWD}/openssl.cnf tsx scripts/debug-usereg.ts
 * 注意：会真实调用超级鹰识别验证码（最多 6 次，约 0.06 元）。
 */
import {ThuClient} from "../src/client/ThuClient";
import {UseregClient, type NetworkCodeSolver} from "../src/client/usereg";
import {createChaojiyingCodeSolver} from "../src/client/captcha/chaojiying";
import {config} from "../src/config/env";

const mask = (s: string): string => (s.length <= 4 ? "***" : `${s.slice(0, 2)}***${s.slice(-2)}(${s.length} 字符)`);

async function main(): Promise<void> {
    if (!config.chaojiying.configured) {
        console.error("超级鹰未配置（CJY_*），无法自动识别验证码。请先配置。");
        process.exit(1);
    }
    const solver: NetworkCodeSolver = createChaojiyingCodeSolver();

    console.log("== 第 0 步：Info 登录，取 emailName ==");
    const thu = new ThuClient();
    await thu.login();
    const info = await thu.getUserInfo();
    const studentId = config.thu.username;
    console.log(`学号=${mask(studentId)}  emailName=${mask(info.emailName)}  相同=${info.emailName === studentId}`);

    const candidates: {label: string; username: string}[] =
        process.argv.includes("--both")
            ? [{label: "学号", username: studentId}, {label: "emailName", username: info.emailName}]
            : [{label: "emailName", username: info.emailName}];

    for (const {label, username} of candidates) {
        console.log(`\n== 尝试用户名=${label} ${mask(username)} ==`);
        const client = new UseregClient(solver, config.thu.password, {
            username,
            onDebug: (line: string) => console.log(`  [debug] ${line}`),
        });
        try {
            const status = await client.getStatus();
            console.log(`  ✓ 登录并查询成功：套餐=${status.balance.productName} 余额=${status.balance.accountBalance} 在线设备=${status.devices.length} 台`);
            console.log(`\n结论：校园网用户名应使用 ${label}。`);
            return;
        } catch (e) {
            console.log(`  ✗ 失败：${(e as Error).message}`);
        }
    }
    console.log("\n两种用户名都失败：若 debug 里 validate 返回的始终是账号类错误，");
    console.log("大概率是校园网密码与 Info 密码不同（可在 usereg 自助服务里核对），或加密链路有差异（把 debug 输出发给我）。");
}

main().catch((e) => {
    console.error("诊断脚本异常：", (e as Error).message);
    process.exit(1);
});
