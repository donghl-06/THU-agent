/** 生产路径验证：直接调 getSportsResources skill，看用户实际收到的返回 */
import {SportsClient} from "../src/client/sports/SportsClient";
import {createGetSportsResourcesSkill} from "../src/skills/sports/getSportsResources";

const keyword = process.argv[2] ?? "乒乓球";
const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const client = new SportsClient();
const skill = createGetSportsResourcesSkill(client);
const r = await skill.execute({resourceName: keyword, date}) as {
    success: boolean;
    data?: {venues: Array<{name: string; sessions: unknown[]}>; note?: string};
    error?: {code: string; message: string};
};
console.log(`\n===== skill.execute({resourceName: "${keyword}", date: "${date}"}) =====`);
if (!r.success) {
    console.log(`FAIL [${r.error?.code}]: ${r.error?.message.slice(0, 300)}`);
} else {
    for (const v of r.data!.venues) {
        console.log(`${v.name}: ${v.sessions.length} 个可约时段`);
        for (const s of v.sessions.slice(0, 6)) {
            const x = s as {time: string; total: number; availableFields: string[]};
            console.log(`  ${x.time}: ${x.availableFields.length}/${x.total} 可约（${x.availableFields.slice(0, 4).join("、")}）`);
        }
    }
    if (r.data!.note) console.log(`note: ${r.data!.note}`);
}
