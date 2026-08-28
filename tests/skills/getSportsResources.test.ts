/**
 * get_sports_resources Skill 独立测试（假数据，无网络）。
 */
import {describe, expect, it} from "vitest";
import {createGetSportsResourcesSkill, type SportsResourcesData} from "../../src/skills/sports/getSportsResources";

const fakeClient = {
    getSportsResources: async (_gymId: string, _itemId: string, _date: string) => ({
        count: 2,
        init: 1,
        phone: "13800000000",
        data: [
            // 可订
            {resId: "1", resHash: "h1", timeSession: "19:00-20:00", fieldName: "1号场", overlaySize: 0, canNetBook: true, cost: 15},
            // 被占用（userType 存在）
            {resId: "2", resHash: "h2", timeSession: "19:00-20:00", fieldName: "2号场", overlaySize: 0, canNetBook: true, cost: 15, userType: "student", paymentStatus: true},
            // 锁定
            {resId: "3", resHash: "h3", timeSession: "19:00-20:00", fieldName: "3号场", overlaySize: 0, canNetBook: true, cost: 15, locked: true},
            // 另一时段可订
            {resId: "4", resHash: "h4", timeSession: "20:00-21:00", fieldName: "1号场", overlaySize: 0, canNetBook: true, cost: 20},
        ],
    }),
};

const skill = createGetSportsResourcesSkill(fakeClient as never);
const exec = async (input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: SportsResourcesData; error?: {code: string; message: string}};

describe("get_sports_resources Skill（假数据，无网络）", () => {
    it("按时段聚合并正确判定可订场地", async () => {
        const r = await exec({resourceName: "气膜馆羽毛球", date: "2026-08-28"});
        expect(r.success).toBe(true);
        expect(r.data!.venues).toHaveLength(1);
        const sessions = r.data!.venues[0].sessions;
        expect(sessions).toHaveLength(2);
        // 19:00-20:00：3 块场地只有 1 号场可订
        expect(sessions[0]).toMatchObject({
            time: "19:00-20:00",
            total: 3,
            availableFields: ["1号场"],
            cost: 15,
        });
        expect(sessions[1]).toMatchObject({time: "20:00-21:00", total: 1, availableFields: ["1号场"], cost: 20});
    });

    it("“羽毛球”关键词匹配全部羽毛球项目（3 个场馆）", async () => {
        const r = await exec({resourceName: "羽毛球", date: "2026-08-28"});
        expect(r.success).toBe(true);
        expect(r.data!.venues.map((v) => v.name)).toEqual([
            "气膜馆羽毛球场", "综体羽毛球场", "西体羽毛球场",
        ]);
    });

    it("关键词无匹配时报错并列出可选项目", async () => {
        const r = await exec({resourceName: "足球场", date: "2026-08-28"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("气膜馆羽毛球场");
    });

    it("非法日期被拒绝", async () => {
        expect((await exec({date: "今晚"})).success).toBe(false);
    });
});
