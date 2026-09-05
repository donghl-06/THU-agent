/**
 * 验证 devKindUuid 假设：siteType 拿运动类型 uuid → current/page 带参对照。
 * 运行：OPENSSL_CONF=${PWD}/openssl.cnf pnpm tsx scripts/debug-devkind.ts [日期] [场景名]
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

// 1. 运动类型筛选项（devKindUuid 的来源）
const siteTypes = (await inner.api(`/api/site/siteType?sceneUuid=${scene.uuid}`)) as
    Array<{label?: string; value?: string} | {uuid?: string; name?: string}>;
console.log(`siteType 返回：`, JSON.stringify(siteTypes).slice(0, 400));

// 2. 级联拿 ROOM
const choose = async (siteType: string, siteUuid: string): Promise<Array<{uuid: string; siteName: string}>> =>
    ((await inner.api(`/api/site/choose?sceneUuid=${scene!.uuid}&siteType=${siteType}&siteUuid=${siteUuid}`)) ??
        []) as Array<{uuid: string; siteName: string}>;
const rooms: Array<{uuid: string; siteName: string}> = [];
for (const c of await choose("CAMPUS", ""))
    for (const b of await choose("BUILDING", c.uuid))
        for (const f of await choose("FLOOR", b.uuid))
            rooms.push(...(await choose("ROOM", f.uuid)));
const room = rooms[0];
console.log(`房间: ${room?.siteName}`);

// 3. 对照实验：不带 vs 带 devKindUuid（取第一个类型）
const first = (siteTypes?.[0] ?? {}) as {value?: string; uuid?: string};
const devKind = first.value ?? first.uuid ?? "";
console.log(`用 devKindUuid = ${devKind}`);

const base = {
    sceneUuid: scene!.uuid, resvKind: "CURRENT_RESERVE", siteType: "DEV",
    classTypeEnum: "ROOM", classTypeUuid: room!.uuid, reserveDate: date,
    sceneUseType: "SPORT_GROUP", pageSize: 999, pageNum: 1,
};
const without = (await inner.api("/api/reserve/current/page", {method: "POST", body: {...base}})) as unknown[];
console.log(`\n不带 devKindUuid → ${Array.isArray(without) ? without.length : "非数组"} 条`);
const withIt = (await inner.api("/api/reserve/current/page", {
    method: "POST",
    body: {...base, devKindUuid: devKind, searchValue: "", siteKindId: ""},
})) as unknown[];
console.log(`带 devKindUuid → ${Array.isArray(withIt) ? withIt.length : "非数组"} 条`);
for (const f of (Array.isArray(withIt) ? withIt : []) as Array<Record<string, unknown>>) {
    const sessions = (f.sessionVo ?? []) as Array<{beginTime: string; endTime: string; reserveStatus?: {reserveStatus?: string; reserveStatusReason?: string}}>;
    const free = sessions.filter((s) => s.reserveStatus?.reserveStatus === "Y")
        .map((s) => `${s.beginTime}-${s.endTime}`).join(", ");
    console.log(`  ${f.siteName}: 场次${sessions.length}，可约: ${free || "无"}`);
}
