/**
 * 调试脚本（一次性）：诊断体育场馆页面返回内容。
 * 打印页面标题和前 400 字符（不含 Cookie）。
 *
 * 运行：pnpm debug:sports
 */
import {InfoHelper} from "@thu-info/lib";
import {uFetch} from "@thu-info/lib/dist/utils/network";
import {config} from "../src/config/env";

const helper = new InfoHelper();
helper.fingerprint = config.thu.fingerprint;
helper.trustFingerprintHook = async () => true;
helper.trustFingerprintNameHook = async () => "thu-assistant-dev";

await helper.login({userId: config.thu.username, password: config.thu.password});
console.log("登录成功。");

// 先走一遍库的完整流程（内部会 roam 建立 gymbook 会话），失败也没关系
try {
    await helper.getSportsResources("3998000", "4045681", "2026-08-28");
    console.log("意外：库的 getSportsResources 直接成功了？");
} catch (e) {
    console.log("库的 getSportsResources 如预期失败：", (e as Error).message);
}

const url =
    "https://webvpn.tsinghua.edu.cn/http/77726476706e69737468656265737421a5a70f8834396657761d88e29d51367b6a00/gymbook/gymBookAction.do?ms=viewGymBook&viewType=m&gymnasium_id=3998000&item_id=4045681&time_date=2026-08-28";

const html = await uFetch(url);
const title = /<title>(.*?)<\/title>/s.exec(html)?.[1]?.trim();
console.log("页面标题：", JSON.stringify(title));
console.log("页面长度：", html.length);
console.log("是否含 limitBookCount：", html.includes("limitBookCount"));
// 去掉 script/style/标签，只看可见文字（错误原因通常在里面）
const text = html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
console.log("可见文字：", JSON.stringify(text.slice(0, 300)));

// 再试 50.tsinghua.edu.cn 经 webvpn 的根路径，判断是整站不通还是只有预约页不通
const rootUrl =
    "https://webvpn.tsinghua.edu.cn/http/77726476706e69737468656265737421a5a70f8834396657761d88e29d51367b6a00/";
const rootHtml = await uFetch(rootUrl);
const rootTitle = /<title>(.*?)<\/title>/s.exec(rootHtml)?.[1]?.trim();
const rootText = rootHtml
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
console.log("\n根路径页面标题：", JSON.stringify(rootTitle));
console.log("根路径可见文字：", JSON.stringify(rootText.slice(0, 300)));

// 方向 1：/http/ 前缀换成 /https/（50 站可能已强制 HTTPS）
const httpsUrl =
    "https://webvpn.tsinghua.edu.cn/https/77726476706e69737468656265737421a5a70f8834396657761d88e29d51367b6a00/gymbook/gymBookAction.do?ms=viewGymBook&viewType=m&gymnasium_id=3998000&item_id=4045681&time_date=2026-08-28";
const httpsHtml = await uFetch(httpsUrl);
const httpsTitle = /<title>(.*?)<\/title>/s.exec(httpsHtml)?.[1]?.trim();
console.log("\n/https/ 变体页面标题：", JSON.stringify(httpsTitle));
console.log("/https/ 变体是否含 limitBookCount：", httpsHtml.includes("limitBookCount"));
if (!httpsHtml.includes("limitBookCount")) {
    const t = httpsHtml
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<style[\s\S]*?<\/style>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    console.log("/https/ 变体可见文字：", JSON.stringify(t.slice(0, 300)));
}
