/** 游泳馆修复实验：SPORT_PERSON × BUILDING/ROOM × devKindUuid 组合矩阵 */
import {SportsClient} from "../src/client/sports/SportsClient";

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const client = new SportsClient();
const inner = client as unknown as {
    login(): Promise<void>;
    api: (p: string, o?: {method?: "POST"; body?: unknown}) => Promise<unknown>;
    listScenes(): Promise<Array<{uuid: string; sceneName: string}>>;
};
await client.login();
const scene = (await client.listScenes()).find((s) => s.sceneName === "陈明游泳馆")!;

// BUILDING 层 uuid（平台用的是 BUILDING 级）
const choose = async (siteType: string, siteUuid: string): Promise<Array<{uuid: string; siteName: string}>> =>
    ((await inner.api(`/api/site/choose?sceneUuid=${scene!.uuid}&siteType=${siteType}&siteUuid=${siteUuid}`)) ??
        []) as Array<{uuid: string; siteName: string}>;
const building = (await choose("BUILDING", (await choose("CAMPUS", ""))[0]!.uuid))[0]!;
console.log(`BUILDING: ${building.siteName} (${building.uuid})`);
const room = (await choose("ROOM", (await choose("FLOOR", building.uuid))[0]!.uuid))[0]!;
console.log(`ROOM: ${room.siteName} (${room.uuid})`);

// "全场" devKindUuid（siteType 列表里 label=全场）
const siteTypes = (await inner.api(`/api/site/siteType?sceneUuid=${scene!.uuid}`)) as Array<{label: string; value: string}>;
const all = siteTypes.find((t) => t.label === "全场");

async function probe(label: string, o: {enumType: string; uuid: string; useType: string; devKind?: string}) {
    const d = (await inner.api("/api/reserve/current/page", {
        method: "POST",
        body: {
            sceneUuid: scene!.uuid, resvKind: "CURRENT_RESERVE", siteType: "DEV", searchValue: "",
            siteKindId: "", classTypeEnum: o.enumType, classTypeUuid: o.uuid, reserveDate: date,
            sceneUseType: o.useType, pageSize: 999, pageNum: 1,
            ...(o.devKind ? {devKindUuid: o.devKind} : {}),
        },
    })) as Array<Record<string, unknown>>;
    const fields = Array.isArray(d) ? d : [];
    const sessions = (fields[0]?.sessionVo ?? []) as Array<{beginTime: string; endTime: string; reserveStatus?: {reserveStatus?: string}}>;
    const free = sessions.filter((s) => s.reserveStatus?.reserveStatus === "Y").map((s) => s.beginTime).join(", ");
    console.log(`[${label}] → ${fields.length} 条；场次: ${sessions.map((s) => `${s.beginTime}${s.reserveStatus?.reserveStatus === "Y" ? "(可约)" : ""}`).join(" ") || "无"}`);
}

await probe("PERSON+BUILDING+devKind(平台同款)", {enumType: "BUILDING", uuid: building.uuid, useType: "SPORT_PERSON", devKind: all?.value});
await probe("PERSON+BUILDING 不带devKind ", {enumType: "BUILDING", uuid: building.uuid, useType: "SPORT_PERSON"});
await probe("PERSON+ROOM    不带devKind ", {enumType: "ROOM", uuid: room.uuid, useType: "SPORT_PERSON"});
