/**
 * 调试脚本（一次性）：手动跟踪 info 门户首页的 302 跳转链，
 * 看 info.tsinghua.edu.cn 的应用会话到底在哪一步建立/断掉。
 * 只打印状态码和主机/路径，不打印任何 Cookie。
 *
 * 运行：pnpm debug:chain
 */
import {InfoHelper} from "@thu-info/lib";
import {cookies} from "@thu-info/lib/dist/utils/network";
import {config} from "../src/config/env";

const helper = new InfoHelper();
helper.fingerprint = config.thu.fingerprint;
helper.trustFingerprintHook = async () => true;
helper.trustFingerprintNameHook = async () => "thu-assistant-dev";
helper.twoFactorMethodHook = async () => "mobile";
helper.twoFactorAuthHook = async () => {
    throw new Error("不应再需要 2FA");
};

await helper.login({
    userId: config.thu.username,
    password: config.thu.password,
});
console.log("登录成功。\n");

const cookieHeader = () =>
    Object.keys(cookies)
        .map((key) => `${key}=${cookies[key]}`)
        .join(";");

// 把 set-cookie 合入本地 cookie 表（复刻库里 uFetch 的解析逻辑）
const mergeCookies = (headers: Headers) => {
    headers.forEach((value, key) => {
        if (key === "set-cookie") {
            if (value.includes("Expires")) {
                const [item, val] = value.split(";")[0].split("=");
                cookies[item.trim()] = val.trim();
            } else {
                for (const v of value.split(",")) {
                    const [item, val] = v.split(";")[0].split("=");
                    if (val) cookies[item.trim()] = val.trim();
                }
            }
        }
    });
};

let location: string =
    "https://webvpn.tsinghua.edu.cn/https/77726476706e69737468656265737421f9f9479369247b59700f81b9991b2631506205de/f/info/gxfw_fg/common/index";

// 实验 0：登录刚结束、还没发任何其他请求时，
// 直接访问 id.tsinghua.edu.cn 的登录页 —— 302 说明 ID 直连会话存在，200 表单说明不存在
{
    const r0 = await fetch(
        "https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/10000ea055dd8d81d09d5a1ba55d39ad",
        {
            headers: {
                "User-Agent": "Mozilla/5.0",
                Cookie: cookieHeader(),
            },
            redirect: "manual",
        },
    );
    console.log(
        "实验 0：登录后立即访问 ID 直连登录页 →",
        r0.status,
        r0.status === 302 ? "（ID 会话存在 ✅）" : "（ID 会话不存在 ❌）",
    );
    // 不合并这次响应的 cookie，避免干扰后续实验
}

for (let i = 0; i < 10; i++) {
    const response = await fetch(location, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            Cookie: cookieHeader(),
        },
        redirect: "manual",
    });
    mergeCookies(response.headers);
    const u = new URL(location);
    console.log(`[${i}] ${response.status} ${u.host}${u.pathname.slice(0, 80)}`);
    if (response.status !== 301 && response.status !== 302) {
        const body = await response.text();
        console.log("    落地页正文前 200 字符：", JSON.stringify(body.slice(0, 200)));
        break;
    }
    location = new URL(response.headers.get("Location") ?? "", location).toString();
}

console.log("\n最终 cookie 名列表：", Object.keys(cookies));
