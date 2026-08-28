/**
 * 集成测试：get_sports_resources 走真实链路（新版体育系统，SportsClient）。
 *
 * 2026-08-28 起旧系统（50.tsinghua.edu.cn）整体下线，数据源切换为新系统。
 * 注意：暑期内全部场馆返回"未开放"属正常（真实闭馆），测试只断言链路与结构。
 */
import {describe, expect, it} from "vitest";
import {SportsClient} from "../../src/client/sports/SportsClient";
import {createGetSportsResourcesSkill, type SportsResourcesData} from "../../src/skills/sports/getSportsResources";

describe("get_sports_resources Skill（真实链路集成测试）", () => {
    it("execute 返回真实场地数据（新系统）", async () => {
        const skill = createGetSportsResourcesSkill(new SportsClient());
        const r = (await skill.execute({resourceName: "羽毛球"})) as {
            success: boolean;
            data?: SportsResourcesData;
            error?: {code: string; message: string};
        };
        if (!r.success) console.log("失败原因：", r.error);
        expect(r.success).toBe(true);
        // 羽毛球应命中气膜馆/综体/西体（后馆+前馆）等场景
        expect(r.data!.venues.length).toBeGreaterThan(0);
        expect(r.data!.venues.some((v) => v.name.includes("气膜馆"))).toBe(true);
        for (const v of r.data!.venues) {
            const available = v.sessions.reduce((n, s) => n + s.availableFields.length, 0);
            console.log(`集成测试：${v.name} ${r.data!.date} 共 ${v.sessions.length} 个可约时段，可订 ${available} 块次场地`);
        }
        if (r.data!.note) console.log("备注：", r.data!.note);
    });
});
