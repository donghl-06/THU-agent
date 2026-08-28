/** 一次性探测：全量查全部场景（用户触发 NETWORK_ERROR 的路径） */
import {SportsClient} from "../src/client/sports/SportsClient";
import {createGetSportsResourcesSkill} from "../src/skills/sports/getSportsResources";

console.time("全量查询");
const skill = createGetSportsResourcesSkill(new SportsClient());
const r = await skill.execute({}) as {success: boolean; data?: {venues: {name: string; sessions: {time: string; availableFields: string[]}[]}[]; note?: string}; error?: {message: string}};
console.timeEnd("全量查询");
if (!r.success) { console.log("失败：", r.error!.message); process.exit(1); }
for (const v of r.data!.venues) {
    const n = v.sessions.reduce((acc, s) => acc + s.availableFields.length, 0);
    console.log(`${v.name}: ${v.sessions.length} 个可约时段, ${n} 块次可订`);
}
console.log("\nnote:", r.data!.note ?? "无");
