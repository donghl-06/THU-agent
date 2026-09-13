/**
 * 调试脚本（一次性）：登录后抓 webvpn 资源列表，
 * 搜索体育/场馆相关的入口，看官方现在指向哪个系统。
 *
 * 运行：pnpm debug:venues
 */
import {InfoHelper} from "@thu-info/lib";
import {uFetch} from "@thu-info/lib/dist/utils/network";
import {config} from "../src/config/env";

const helper = new InfoHelper();
helper.fingerprint = config.thu.fingerprint;
helper.trustFingerprintHook = async () => true;
helper.trustFingerprintNameHook = async () => "QingLing Desktop";

await helper.login({userId: config.thu.username, password: config.thu.password});
console.log("登录成功。\n");

// webvpn 登录后的资源列表页
for (const url of [
    "https://webvpn.tsinghua.edu.cn/",
    "https://webvpn.tsinghua.edu.cn/users/resources",
]) {
    try {
        const html = await uFetch(url);
        const text = html
            .replace(/<script[\s\S]*?<\/script>/g, "")
            .replace(/<style[\s\S]*?<\/style>/g, "");
        // 找出所有含"体育/场馆/运动"的链接及其 href
        const linkRe = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
        let m;
        let found = 0;
        while ((m = linkRe.exec(text)) !== null) {
            const label = m[2].replace(/<[^>]+>/g, "").trim();
            if (/体育|场馆|运动|gym/i.test(label)) {
                console.log(`[${url}] ${label} → ${m[1].slice(0, 120)}`);
                found++;
            }
        }
        console.log(`[${url}] 页面长度 ${html.length}，体育相关链接 ${found} 个`);
        if (found === 0) {
            console.log("  （页面前 200 字可见文本：",
                JSON.stringify(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)), ")");
        }
    } catch (e) {
        console.log(`[${url}] 请求失败：`, (e as Error).message);
    }
}
