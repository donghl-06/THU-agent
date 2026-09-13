/** 游泳馆专项：场景元数据 + 最新级联全层 dump + current/page 变体 */
import {SportsClient} from "../src/client/sports/SportsClient";

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const client = new SportsClient();
const inner = client as unknown as {
    login(): Promise<void>;
    api: (p: string, o?: {method?: "POST"; body?: unknown}) => Promise<unknown>;
    listScenes(): Promise<Array<{uuid: string; sceneName: string; [k: string]: unknown}>>;
};
await client.login();

// 1. 游泳馆场景的完整元数据（找 sceneUseType / relatedType 等游泳特有标识）
const scenes = await client.listScenes();
for (const name of ["陈明游泳馆", "西湖游泳池"]) {
    const s = scenes.find((x) => x.sceneName === name);
    if (s) console.log(`场景 ${name}:`, JSON.stringify(s).slice(0, 400), "\n");
}
const scene = scenes.find((x) => x.sceneName === "陈明游泳馆")!;

// 2. 四层级联全层 dump
const chooseRaw = async (siteType: string, siteUuid: string) =>
    await inner.api(`/api/site/choose?sceneUuid=${scene!.uuid}&siteType=${siteType}&siteUuid=${siteUuid}`);
const campuses = (await chooseRaw("CAMPUS", "")) as Array<Record<string, unknown>>;
console.log(`CAMPUS:`, JSON.stringify(campuses).slice(0, 300));
const buildings = (await chooseRaw("BUILDING", (campuses[0]!.uuid as string))) as Array<Record<string, unknown>>;
console.log(`BUILDING:`, JSON.stringify(buildings).slice(0, 300));
const floors = (await chooseRaw("FLOOR", (buildings[0]!.uuid as string))) as Array<Record<string, unknown>>;
console.log(`FLOOR:`, JSON.stringify(floors).slice(0, 300));
const rooms = (await chooseRaw("ROOM", (floors[0]!.uuid as string))) as Array<Record<string, unknown>>;
console.log(`ROOM:`, JSON.stringify(rooms).slice(0, 400));
const room = rooms[0]! as {uuid: string};

// 3. current/page 变体
const base = {
    sceneUuid: scene!.uuid, resvKind: "CURRENT_RESERVE", siteType: "DEV", searchValue: "",
    siteKindId: "", classTypeEnum: "ROOM", classTypeUuid: room!.uuid, reserveDate: date,
    sceneUseType: "SPORT_GROUP", pageSize: 999, pageNum: 1,
};
const a = await inner.api("/api/reserve/current/page", {method: "POST", body: {...base}});
console.log(`\n[标准] →`, JSON.stringify(a).slice(0, 200));
const b = await inner.api("/api/reserve/current/page", {
    method: "POST",
    body: {...base, sceneUseType: undefined, resvKind: "CURRENT_RESERVE", siteType: "ROOM"},
});
console.log(`[siteType=ROOM] →`, JSON.stringify(b).slice(0, 200));
// 4. 管理端同款 current/list 试一下
const c = await inner.api("/api/reserve/current/list", {
    method: "POST",
    body: {sceneUuid: scene!.uuid, resvKind: "CURRENT_RESERVE"},
});
console.log(`[current/list 无日期] →`, JSON.stringify(c).slice(0, 300));
