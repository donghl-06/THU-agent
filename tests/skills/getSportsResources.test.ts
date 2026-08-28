/**
 * get_sports_resources Skill 独立测试（假数据，无网络）。
 * 数据源已切换到新版体育系统（SportsClient），这里注入假 client。
 * 可约性以每块场地的场次表（sessions）为准——availableRange 只是
 * "没被场次覆盖的空白时间"，不可用于可约判定（2026-08-29 修正）。
 */
import {describe, expect, it} from "vitest";
import {createGetSportsResourcesSkill, type SportsResourcesData} from "../../src/skills/sports/getSportsResources";
import type {SportsField} from "../../src/client/sports/SportsClient";
import {ThuError} from "../../src/client/errors";

const SCENES = [
    {uuid: "u1", sceneName: "气膜馆羽毛球", relatedType: "DEV"},
    {uuid: "u2", sceneName: "综体羽毛球", relatedType: "DEV"},
    {uuid: "u3", sceneName: "西体羽毛球(后馆)", relatedType: "DEV"},
    {uuid: "u4", sceneName: "西体台球", relatedType: "DEV"},
];

/** 快速构造场次制场地 */
function field(
    uuid: string,
    siteName: string,
    sessions: {start: string; end: string; available: boolean; reason?: string; feeYuan?: number | null}[],
    overall: {reserveStatus: "Y" | "N"; reserveStatusReason?: string} = {reserveStatus: "Y"},
): SportsField {
    return {
        uuid, siteName, siteType: "DEV", kindName: "羽毛球", location: "", sceneUuid: "u-x",
        reserveStatus: {...overall, availableRange: []},
        formUuid: "",
        sessions: sessions.map((s, i) => ({uuid: `${uuid}-s${i}`, feeYuan: null, ...s})),
        supportPeriod: false,
        bookableWindow: null,
        feeRuleVo: null,
    };
}

/** 按场景 uuid 返回假场地数据：u1 有可约场次，u2 场次全满，u3/u4 未开放 */
const FIELDS: Record<string, SportsField[]> = {
    u1: [
        field("f1", "羽01", [
            {start: "18:00", end: "20:00", available: true, feeYuan: 40},
            {start: "20:00", end: "22:00", available: false, reason: "当前场次预约人数已满"},
        ]),
        field("f2", "羽02", [
            {start: "18:00", end: "20:00", available: true, feeYuan: 40},
            {start: "20:00", end: "22:00", available: true, feeYuan: 40},
        ]),
        field("f3", "羽03", [
            {start: "18:00", end: "20:00", available: false, reason: "当前场次预约人数已满"},
            {start: "20:00", end: "22:00", available: false, reason: "场次已被锁场"},
        ]),
    ],
    u2: [
        field("f4", "综羽01", [
            {start: "18:00", end: "20:00", available: false, reason: "当前场次预约人数已满"},
        ]),
    ],
    u3: [
        field("f5", "西羽01", [], {reserveStatus: "N", reserveStatusReason: "未开放"}),
    ],
    u4: [
        field("f6", "台球01", [], {reserveStatus: "N", reserveStatusReason: "未开放"}),
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
    it("按场次聚合并列出可订场地（只统计 available 的场次）", async () => {
        const r = await exec({resourceName: "气膜馆", date: "2026-08-29"});
        expect(r.success).toBe(true);
        expect(r.data!.venues).toHaveLength(1);
        const sessions = r.data!.venues[0].sessions;
        expect(sessions).toHaveLength(2);
        // 18:00-20:00：羽01、羽02 可订（羽03 已满）；价格从场次带出来
        expect(sessions[0]).toMatchObject({
            time: "18:00-20:00",
            total: 3,
            availableFields: ["羽01", "羽02"],
            cost: 40,
        });
        expect(sessions[1]).toMatchObject({time: "20:00-22:00", availableFields: ["羽02"]});
    });

    it("场次全满时返回空 sessions + note 说明，不编造可约时段", async () => {
        const r = await exec({resourceName: "综体", date: "2026-08-29"});
        expect(r.success).toBe(true);
        expect(r.data!.venues[0].sessions).toHaveLength(0);
        expect(r.data!.note).toContain("综体羽毛球");
        expect(r.data!.note).toContain("订满");
    });

    it("“羽毛球”关键词匹配全部羽毛球场景（3 个）", async () => {
        const r = await exec({resourceName: "羽毛球", date: "2026-08-29"});
        expect(r.success).toBe(true);
        expect(r.data!.venues.map((v) => v.name)).toEqual([
            "气膜馆羽毛球", "综体羽毛球", "西体羽毛球(后馆)",
        ]);
        expect(r.data!.note).toContain("西体羽毛球(后馆)（未开放）");
    });

    it("关键词无匹配时报错并列出可选场景", async () => {
        const r = await exec({resourceName: "足球场", date: "2026-08-29"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("气膜馆羽毛球");
    });

    it("非法日期被拒绝", async () => {
        expect((await exec({date: "今晚"})).success).toBe(false);
    });

    it("自由时段场地（无场次表、supportPeriod）回退用 availableRange 并按 bookableWindow 裁剪", async () => {
        const client = {
            listScenes: async () => [{uuid: "u9", sceneName: "测试馆", relatedType: "DEV"}],
            getFieldPage: async (): Promise<SportsField[]> => [{
                uuid: "f9", siteName: "测01", siteType: "DEV", kindName: "测试", location: "", sceneUuid: "u9",
                reserveStatus: {reserveStatus: "Y", availableRange: [{startTime: "06:00", endTime: "09:00"}]},
                formUuid: "",
                sessions: [],
                supportPeriod: true,
                bookableWindow: {start: "08:00", end: "22:00"},
                feeRuleVo: null,
            }],
        };
        const s = createGetSportsResourcesSkill(client as never);
        const r = (await s.execute({resourceName: "测试馆", date: "2026-08-29"})) as {
            success: boolean; data?: SportsResourcesData;
        };
        expect(r.success).toBe(true);
        // 06:00-09:00 裁剪为 08:00-09:00
        expect(r.data!.venues[0].sessions[0].time).toBe("08:00-09:00");
    });

    it("场次制场地的 availableRange 空白段（如打烊后）绝不显示为可约", async () => {
        // 复刻真实 bug：整体 Y + availableRange=[22:00-23:59]，但场次表最后一场 20:00-22:00 已锁
        const client = {
            listScenes: async () => [{uuid: "u8", sceneName: "夜场馆", relatedType: "DEV"}],
            getFieldPage: async (): Promise<SportsField[]> => [{
                uuid: "f8", siteName: "夜01", siteType: "DEV", kindName: "羽毛球", location: "", sceneUuid: "u8",
                reserveStatus: {reserveStatus: "Y", availableRange: [{startTime: "22:00", endTime: "23:59"}]},
                formUuid: "",
                sessions: [{uuid: "f8-s0", start: "20:00", end: "22:00", available: false, reason: "场次已被锁场", feeYuan: 40}],
                supportPeriod: false,
                bookableWindow: {start: "08:00", end: "23:59"},
                feeRuleVo: null,
            }],
        };
        const s = createGetSportsResourcesSkill(client as never);
        const r = (await s.execute({resourceName: "夜场馆", date: "2026-08-29"})) as {
            success: boolean; data?: SportsResourcesData;
        };
        expect(r.success).toBe(true);
        expect(r.data!.venues[0].sessions).toHaveLength(0); // 22:00-23:59 不得出现
    });

    it("单场景查询失败时降级为 note，不影响其他场景", async () => {
        const client = {
            listScenes: async () => SCENES,
            getFieldPage: async (sceneUuid: string, _date: string): Promise<SportsField[]> => {
                if (sceneUuid === "u2") throw new ThuError("NETWORK_ERROR", "体育系统网络请求失败（fetch failed）");
                return FIELDS[sceneUuid] ?? [];
            },
        };
        const s = createGetSportsResourcesSkill(client as never);
        const r = (await s.execute({resourceName: "羽毛球", date: "2026-08-29"})) as {
            success: boolean; data?: SportsResourcesData;
        };
        expect(r.success).toBe(true);
        // 气膜馆正常出数据，综体的失败写进 note
        expect(r.data!.venues[0].sessions.length).toBeGreaterThan(0);
        expect(r.data!.note).toContain("综体羽毛球（查询失败");
    });

    it("全部未开放时正常返回空 sessions + note（暑假闭馆场景）", async () => {
        const r = await exec({resourceName: "台球", date: "2026-08-29"});
        expect(r.success).toBe(true);
        expect(r.data!.venues[0].sessions).toHaveLength(0);
        expect(r.data!.note).toContain("未开放");
    });
});
