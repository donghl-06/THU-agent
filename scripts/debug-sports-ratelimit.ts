/**
 * 限流验证探针（一次性）：
 * 阶段1 串行查「羽毛球/乒乓球/网球」（看板拟采用的节奏），统计请求数与耗时；
 * 阶段2 新建 8 个独立客户端（各自独立节流闸）并发请求，模拟无节流的突发流量，
 *       观察是否出现「请求频繁」。
 */
import {SportsClient} from "../src/client/sports/SportsClient";
import {createGetSportsResourcesSkill} from "../src/skills/sports/getSportsResources";

let total = 0;
let rateLimited = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    total++;
    const resp = await origFetch(...args);
    const clone = resp.clone();
    // 体育平台的限流是业务层 {message:"请求频繁"}，异步偷看一下不挡主流程
    if (clone.headers.get("content-type")?.includes("json")) {
        void clone.text().then((t) => { if (t.includes("请求频繁")) rateLimited++; }).catch(() => {});
    }
    return resp;
}) as typeof fetch;

const client = new SportsClient();
const skill = createGetSportsResourcesSkill(client);

console.log("=== 阶段1：单客户端串行查 3 个项目（客户端自带 300ms 节流） ===");
for (const kw of ["羽毛球", "乒乓球", "网球"]) {
    const before = total;
    const t0 = Date.now();
    const r = await skill.execute({resourceName: kw}) as {
        success: boolean;
        data?: {venues: {name: string; sessions: {availableFields: string[]}[]}[]; note?: string};
        error?: {code: string; message: string};
    };
    const venues = r.success ? r.data!.venues : [];
    const open = venues.reduce((n, v) => n + v.sessions.filter((s) => s.availableFields.length > 0).length, 0);
    console.log(
        `${kw}: ${r.success ? `OK · ${venues.length} 个场景 · ${open} 个可订时段` : `FAIL [${r.error!.code}] ${r.error!.message.slice(0, 100)}`}` +
        ` | 请求 ${total - before} 个 | ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
}
console.log(`阶段1 合计：${total} 个请求`);

console.log("\n=== 阶段2：4 个已登录客户端并发 getFieldPage（绕开单客户端节流闸，直击场地接口） ===");
const clients: SportsClient[] = [];
for (let i = 0; i < 4; i++) {
    const c = new SportsClient();
    await c.login(); // 串行登录：并发登录会被统一身份认证拒（阶段2预演已实测）
    clients.push(c);
}
const scenes = await clients[0].listScenes();
const targets = scenes.filter((s) => /羽毛球|乒乓球|网球/.test(s.sceneName)).slice(0, 4);
console.log(`并发目标：${targets.map((s) => s.sceneName).join("、")}`);
const before2 = total;
const t1 = Date.now();
const burst = await Promise.allSettled(
    targets.map((s, i) => clients[i % clients.length].getFieldPage(s.uuid, new Date().toISOString().slice(0, 10))),
);
let okCount = 0;
burst.forEach((r, i) => {
    if (r.status === "fulfilled") {
        okCount++;
        console.log(`#${i + 1} ${targets[i].sceneName}: OK（${(r.value as unknown[]).length} 块场地）`);
    } else {
        console.log(`#${i + 1} ${targets[i].sceneName}: FAIL ${(r.reason as Error).message?.slice(0, 120)}`);
    }
});
console.log(`并发结果：成功 ${okCount}/${targets.length} | 请求 ${total - before2} 个 | ${((Date.now() - t1) / 1000).toFixed(1)}s`);
console.log(`\n全程：${total} 个请求，捕获到「请求频繁」响应 ${rateLimited} 次`);
