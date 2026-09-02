/** 解耦实验：room uuid（新级联 vs 旧硬编码）× searchValue/siteKindId（带 vs 不带） */
import {SportsClient} from "../src/client/sports/SportsClient";

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const client = new SportsClient();
const inner = client as unknown as {
    login(): Promise<void>;
    api: (p: string, o?: {method?: "POST"; body?: unknown}) => Promise<unknown>;
    listScenes(): Promise<{uuid: string; sceneName: string}[]>;
};
await client.login();
const scene = (await client.listScenes()).find((s) => s.sceneName === "气膜馆羽毛球")!;

const choose = async (siteType: string, siteUuid: string): Promise<Array<{uuid: string; siteName: string}>> =>
    ((await inner.api(`/api/site/choose?sceneUuid=${scene!.uuid}&siteType=${siteType}&siteUuid=${siteUuid}`)) ??
        []) as Array<{uuid: string; siteName: string}>;
const rooms: Array<{uuid: string; siteName: string}> = [];
for (const c of await choose("CAMPUS", ""))
    for (const b of await choose("BUILDING", c.uuid))
        for (const f of await choose("FLOOR", b.uuid))
            rooms.push(...(await choose("ROOM", f.uuid)));
const newUuid = rooms[0]!.uuid;
const oldUuid = "0fdca2067fae489ea592f81fae3b3a15";
console.log(`新级联 uuid = ${newUuid}\n旧硬编码 uuid = ${oldUuid}\n${newUuid === oldUuid ? "两者相同" : "两者不同！"}\n`);

async function probe(label: string, uuid: string, withEmpty: boolean) {
    const d = (await inner.api("/api/reserve/current/page", {
        method: "POST",
        body: {
            sceneUuid: scene!.uuid, resvKind: "CURRENT_RESERVE", siteType: "DEV",
            ...(withEmpty ? {searchValue: "", siteKindId: ""} : {}),
            classTypeEnum: "ROOM", classTypeUuid: uuid, reserveDate: date,
            sceneUseType: "SPORT_GROUP", pageSize: 999, pageNum: 1,
        },
    })) as unknown[];
    console.log(`[${label}] → ${Array.isArray(d) ? d.length : "非数组"} 条`);
}

await probe("新uuid + 不带空参", newUuid, false);
await probe("新uuid + 带空参  ", newUuid, true);
await probe("旧uuid + 不带空参", oldUuid, false);
await probe("旧uuid + 带空参  ", oldUuid, true);
