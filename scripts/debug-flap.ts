/**
 * 间歇性空壳验证：同一请求连续多次 + 正确 devKindUuid（"羽毛球"）对照。
 * 运行：OPENSSL_CONF=${PWD}/openssl.cnf pnpm tsx scripts/debug-flap.ts [日期] [场景名]
 */
import {SportsClient} from "../src/client/sports/SportsClient";

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const sceneName = process.argv[3] ?? "气膜馆羽毛球";
const client = new SportsClient();
const inner = client as unknown as {
    login(): Promise<void>;
    api: (p: string, o?: {method?: "POST"; body?: unknown}) => Promise<unknown>;
    listScenes(): Promise<{uuid: string; sceneName: string}[]>;
};
await client.login();
const scene = (await client.listScenes()).find((s) => s.sceneName === sceneName)!;
const room = "0fdca2067fae489ea592f81fae3b3a15"; // 气膜馆羽毛球场 ROOM uuid（前序探针确认，固定省级联请求）

// 1. 找"羽毛球"的 devKindUuid
const siteTypes = (await inner.api(`/api/site/siteType?sceneUuid=${scene.uuid}`)) as
    Array<{label: string; value: string}>;
const badminton = siteTypes.find((t) => t.label?.includes("羽毛球"));
console.log(`羽毛球 devKindUuid = ${badminton?.value ?? "（未找到）"}`);

const body = {
    sceneUuid: scene!.uuid, resvKind: "CURRENT_RESERVE", siteType: "DEV", searchValue: "",
    siteKindId: "", classTypeEnum: "ROOM", classTypeUuid: room, reserveDate: date,
    sceneUseType: "SPORT_GROUP", pageSize: 999, pageNum: 1,
};

// 2. 同一请求连续 4 次（间隔 4 秒）——看空壳是否波动
for (let i = 1; i <= 4; i++) {
    const d = (await inner.api("/api/reserve/current/page", {method: "POST", body: {...body}})) as unknown[];
    const n = Array.isArray(d) ? d.length : -1;
    let free = -1;
    if (n > 0) {
        free = (d as Array<{sessionVo?: Array<{reserveStatus?: {reserveStatus?: string}}>}>)
            .reduce((s, f) => s + (f.sessionVo ?? []).filter((x) => x.reserveStatus?.reserveStatus === "Y").length, 0);
    }
    console.log(`第${i}次（间隔4s）: ${n} 条场地, 可约场次 ${free}`);
    if (i < 4) await new Promise((r) => setTimeout(r, 4000));
}

// 3. 带"羽毛球" devKindUuid
if (badminton?.value) {
    const d = (await inner.api("/api/reserve/current/page", {
        method: "POST", body: {...body, devKindUuid: badminton.value},
    })) as unknown[];
    console.log(`带羽毛球 devKindUuid: ${Array.isArray(d) ? d.length : -1} 条场地`);
}
