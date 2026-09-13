/** 排查"不在提前预约范围内"：今天乒乓/羽毛球的场次原始 status+reason（控制请求量） */
import {SportsClient} from "../src/client/sports/SportsClient";

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const names = process.argv[3] ? [process.argv[3]] : ["北体乒乓球", "气膜馆羽毛球"];
const client = new SportsClient();
const inner = client as unknown as {
    login(): Promise<void>;
    api: (p: string, o?: {method?: "POST"; body?: unknown}) => Promise<unknown>;
    listScenes(): Promise<{uuid: string; sceneName: string}[]>;
};
await client.login();
const scenes = await client.listScenes();

for (const name of names) {
    const scene = scenes.find((s) => s.sceneName === name);
    if (!scene) { console.log(`场景不存在：${name}`); continue; }
    const choose = async (siteType: string, siteUuid: string): Promise<Array<{uuid: string; siteName: string}>> =>
        ((await inner.api(`/api/site/choose?sceneUuid=${scene!.uuid}&siteType=${siteType}&siteUuid=${siteUuid}`)) ??
            []) as Array<{uuid: string; siteName: string}>;
    const rooms: Array<{uuid: string; siteName: string}> = [];
    for (const c of await choose("CAMPUS", ""))
        for (const b of await choose("BUILDING", c.uuid))
            for (const f of await choose("FLOOR", b.uuid))
                rooms.push(...(await choose("ROOM", f.uuid)));
    console.log(`\n===== ${name} [${date}]：${rooms.length} 房间 =====`);
    for (const room of rooms) {
        const fields = (await inner.api("/api/reserve/current/page", {
            method: "POST",
            body: {
                classTypeUuid: room.uuid, classTypeEnum: "ROOM", sceneUuid: scene!.uuid,
                reserveDate: date, pageSize: 999, pageNum: 1, siteKindId: "",
                searchValue: "", resvKind: "CURRENT_RESERVE",
            },
        })) as Array<Record<string, unknown>>;
        console.log(`房间 ${room.siteName}：${fields.length} 块场地`);
        for (const f of fields.slice(0, 3)) {
            const sessions = (f.sessionVo ?? []) as Array<{beginTime: string; endTime: string;
                reserveStatus?: {reserveStatus?: string; reserveStatusReason?: string}}>;
            const overall = f.reserveStatus as {reserveStatus?: string; reserveStatusReason?: string} | undefined;
            console.log(`  ${f.siteName}: 整体=${overall?.reserveStatus}${overall?.reserveStatusReason ? `(${overall.reserveStatusReason})` : ""}`);
            for (const s of sessions) {
                console.log(`    ${s.beginTime}-${s.endTime}: ${s.reserveStatus?.reserveStatus}${s.reserveStatus?.reserveStatusReason ? `(${s.reserveStatus.reserveStatusReason})` : ""}`);
            }
        }
    }
}
