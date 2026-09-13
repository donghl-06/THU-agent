/**
 * 调试脚本（一次性）：诊断 roam 失败 ——
 * 请求 ROAMING_URL 并打印 result / msg（object 含漫游票据，不打印）。
 *
 * 运行：pnpm debug:roam
 */
import {InfoHelper} from "@thu-info/lib";
import {cookies} from "@thu-info/lib/dist/utils/network";
import {getCsrfToken} from "@thu-info/lib/dist/lib/core";
import {config} from "../src/config/env";

const helper = new InfoHelper();
helper.fingerprint = config.thu.fingerprint;
helper.trustFingerprintHook = async () => true;
helper.trustFingerprintNameHook = async () => "QingLing Desktop";
helper.twoFactorMethodHook = async () => "mobile";
helper.twoFactorAuthHook = async () => {
    throw new Error("不应再需要 2FA —— 如果被要求，说明信任设备未生效");
};

await helper.login({
    userId: config.thu.username,
    password: config.thu.password,
});
console.log("登录成功。");

const csrf = await getCsrfToken();
console.log("CSRF token 获取成功（长度", csrf.length, "）");

const payload = "F315577F5BF20E1B1668EDD594B2C04F"; // getUserInfo 的 yyfwid
const url = `https://webvpn.tsinghua.edu.cn/https/77726476706e69737468656265737421f9f9479369247b59700f81b9991b2631506205de/b/yyfw/vyyfwxx/info/portal_fg/common/onlineAppRedirect?yyfwid=${payload}&_csrf=${csrf}&machine=p`;

const cookieHeader = Object.keys(cookies)
    .map((key) => `${key}=${cookies[key]}`)
    .join(";");

const response = await fetch(url, {
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Cookie: cookieHeader,
    },
});
const body = await response.text();
console.log("HTTP 状态码：", response.status);
try {
    const json = JSON.parse(body);
    console.log("result:", json.result);
    console.log("msg:", json.msg);
    console.log("object 是否为 null:", json.object === null);
} catch {
    console.log("响应不是 JSON，正文前 300 字符：", JSON.stringify(body.slice(0, 300)));
}
