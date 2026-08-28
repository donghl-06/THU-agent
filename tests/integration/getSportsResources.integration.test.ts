/**
 * 集成测试：get_sports_resources 走真实链路（以羽毛球为例）。
 */
import {describe, expect, it} from "vitest";
import {ThuClient} from "../../src/client/ThuClient";
import {createGetSportsResourcesSkill, type SportsResourcesData} from "../../src/skills/sports/getSportsResources";

describe("get_sports_resources Skill（真实链路集成测试）", () => {
    // 2026-08-28 起：50.tsinghua.edu.cn 经 webvpn 全站 PARSE_FAILED（服务器端故障/迁移），
    // 与我们的代码无关。系统恢复后把 it.skip 改回 it 即可。
    it.skip("execute 返回真实场地数据（上游系统当前不可达，暂停）", async () => {
        const skill = createGetSportsResourcesSkill(new ThuClient());
        const r = (await skill.execute({resourceName: "羽毛球"})) as {
            success: boolean;
            data?: SportsResourcesData;
            error?: {code: string; message: string};
        };
        if (!r.success) console.log("失败原因：", r.error);
        expect(r.success).toBe(true);
        expect(r.data!.venues.length).toBeGreaterThan(0);
        for (const v of r.data!.venues) {
            const available = v.sessions.reduce((n, s) => n + s.availableFields.length, 0);
            console.log(`集成测试：${v.name} ${r.data!.date} 共 ${v.sessions.length} 个时段，可订场地 ${available} 块`);
        }
        if (r.data!.note) console.log("备注：", r.data!.note);
    });
});
