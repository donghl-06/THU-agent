/**
 * get_sports_resources Skill 独立测试（假数据，无网络）。
 * 数据源已切换到新版体育系统（SportsClient），这里注入假 client。
 */
import {describe, expect, it} from "vitest";
import {createGetSportsResourcesSkill, type SportsResourcesData} from "../../src/skills/sports/getSportsResources";

const SCENES = [
    {uuid: "u1", sceneName: "气膜馆羽毛球", relatedType: "DEV"},
    {uuid: "u2", sceneName: "综体羽毛球", relatedType: "DEV"},
    {uuid: "u3", sceneName: "西体羽毛球(后馆)", relatedType: "DEV"},
    {uuid: "u4", sceneName: "西体台球", relatedType: "DEV"},
];

/** 按场景 uuid 返回假场地数据：u1 有可约时段，u2 全被约满，u3/u4 未开放 */
const FIELDS: Record<string, object[]> = {
    u1: [
        {uuid: "f1", siteName: "羽01", siteType: "DEV", kindName: "羽毛球", location: "清华/气膜馆/1F",
            reserveStatus: {reserveStatus: "Y", availableRange: [{startTime: "19:00", endTime: "20:00"}]}, feeRuleVo: null},
        {uuid: "f2", siteName: "羽02", siteType: "DEV", kindName: "羽毛球", location: "清华/气膜馆/1F",
            reserveStatus: {reserveStatus: "Y", availableRange: [
                {startTime: "19:00", endTime: "20:00"},
                {startTime: "20:00", endTime: "21:00"},
            ]}, feeRuleVo: null},
        {uuid: "f3", siteName: "羽03", siteType: "DEV", kindName: "羽毛球", location: "清华/气膜馆/1F",
            reserveStatus: {reserveStatus: "N", reserveStatusReason: "已约满", availableRange: []}, feeRuleVo: null},
    ],
    u2: [
        {uuid: "f4", siteName: "综羽01", siteType: "DEV", kindName: "羽毛球", location: "清华/综体",
            reserveStatus: {reserveStatus: "N", reserveStatusReason: "已约满", availableRange: []}, feeRuleVo: null},
    ],
    u3: [
        {uuid: "f5", siteName: "西羽01", siteType: "DEV", kindName: "羽毛球", location: "清华/西体",
            reserveStatus: {reserveStatus: "N", reserveStatusReason: "未开放", availableRange: []}, feeRuleVo: null},
    ],
    u4: [
        {uuid: "f6", siteName: "台球01", siteType: "DEV", kindName: "台球", location: "清华/西体",
            reserveStatus: {reserveStatus: "N", reserveStatusReason: "未开放", availableRange: []}, feeRuleVo: null},
    ],
};

const fakeClient = {
    listScenes: async () => SCENES,
    getFieldPage: async (sceneUuid: string, _date: string) => FIELDS[sceneUuid] ?? [],
};

const skill = createGetSportsResourcesSkill(fakeClient as never);
const exec = async (input?: unknown) =>
    (await skill.execute(input)) as {success: boolean; data?: SportsResourcesData; error?: {code: string; message: string}};

describe("get_sports_resources Skill（假数据，无网络）", () => {
    it("按可约时间段聚合并列出可订场地", async () => {
        const r = await exec({resourceName: "气膜馆", date: "2026-08-28"});
        expect(r.success).toBe(true);
        expect(r.data!.venues).toHaveLength(1);
        const sessions = r.data!.venues[0].sessions;
        expect(sessions).toHaveLength(2);
        // 19:00-20:00：羽01、羽02 可订（羽03 已约满）
        expect(sessions[0]).toMatchObject({
            time: "19:00-20:00",
            total: 3,
            availableFields: ["羽01", "羽02"],
        });
        expect(sessions[1]).toMatchObject({time: "20:00-21:00", availableFields: ["羽02"]});
    });

    it("“羽毛球”关键词匹配全部羽毛球场景（3 个）", async () => {
        const r = await exec({resourceName: "羽毛球", date: "2026-08-28"});
        expect(r.success).toBe(true);
        expect(r.data!.venues.map((v) => v.name)).toEqual([
            "气膜馆羽毛球", "综体羽毛球", "西体羽毛球(后馆)",
        ]);
        // 未开放/约满的场景在 note 里说明
        expect(r.data!.note).toContain("综体羽毛球");
        expect(r.data!.note).toContain("西体羽毛球(后馆)（未开放）");
    });

    it("关键词无匹配时报错并列出可选场景", async () => {
        const r = await exec({resourceName: "足球场", date: "2026-08-28"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("气膜馆羽毛球");
    });

    it("非法日期被拒绝", async () => {
        expect((await exec({date: "今晚"})).success).toBe(false);
    });

    it("全部未开放时正常返回空 sessions + note（暑假闭馆场景）", async () => {
        const r = await exec({resourceName: "台球", date: "2026-08-28"});
        expect(r.success).toBe(true);
        expect(r.data!.venues[0].sessions).toHaveLength(0);
        expect(r.data!.note).toContain("未开放");
    });
});
