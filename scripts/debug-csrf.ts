/**
 * 调试脚本（一次性）：登录后手动请求 GET_COOKIE_URL，
 * 打印响应状态码和正文前 500 字符，用于诊断
 * getCsrfToken 的 "Failed to get csrf token." 错误。
 *
 * 运行：pnpm debug:csrf
 * 注意：不打印任何密码；响应正文里不应包含敏感信息，但只打印截断片段。
 */
import {InfoHelper} from "@thu-info/lib";
import {cookies} from "@thu-info/lib/dist/utils/network";
import {GET_COOKIE_URL} from "@thu-info/lib/dist/constants/strings";
import {config} from "../src/config/env";

const helper = new InfoHelper();
helper.fingerprint = config.thu.fingerprint;
helper.trustFingerprintHook = async () => true;
helper.trustFingerprintNameHook = async () => "thu-assistant-dev";
helper.twoFactorMethodHook = async () => "mobile";
helper.twoFactorAuthHook = async () => {
    throw new Error("不应再需要 2FA —— 如果被要求，说明信任设备未生效");
};

await helper.login({
    userId: config.thu.username,
    password: config.thu.password,
});
console.log("登录成功。");
console.log("当前 cookie 名列表：", Object.keys(cookies));

const cookieHeader = () =>
    Object.keys(cookies)
        .map((key) => `${key}=${cookies[key]}`)
        .join(";");

const fetchRaw = async (url: string) => {
    const response = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            Cookie: cookieHeader(),
        },
        redirect: "manual",
    });
    const body = await response.text();
    return {status: response.status, headers: response.headers, body};
};

// 实验：先访问 webvpn 包装的 info 门户首页，再看 cookie 端点是否有内容
const INFO_INDEX_URL =
    "https://webvpn.tsinghua.edu.cn/https/77726476706e69737468656265737421f9f9479369247b59700f81b9991b2631506205de/f/info/gxfw_fg/common/index";

console.log("\n--- 第一次请求 cookie 端点（未先访问门户）---");
let r = await fetchRaw(GET_COOKIE_URL);
console.log("状态码：", r.status, "正文：", JSON.stringify(r.body.slice(0, 200)));

console.log("\n--- 访问 webvpn 门户首页 ---");
r = await fetchRaw(INFO_INDEX_URL);
console.log("状态码：", r.status, "正文前 200 字符：", JSON.stringify(r.body.slice(0, 200)));
const tokenInPage = /XSRF-TOKEN=([^;"']+)/.exec(r.body);
console.log("首页正文中是否含 XSRF-TOKEN：", tokenInPage ? "是" : "否");

console.log("\n--- 第二次请求 cookie 端点（访问门户之后）---");
r = await fetchRaw(GET_COOKIE_URL);
console.log("状态码：", r.status, "正文：", JSON.stringify(r.body.slice(0, 200)));
const tokenInCookie = /XSRF-TOKEN=(.+?);/.exec(r.body + ";");
console.log("XSRF-TOKEN 匹配结果：", tokenInCookie ? "成功" : "失败");
