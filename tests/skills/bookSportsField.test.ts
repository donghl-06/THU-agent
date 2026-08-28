/**
 * book_sports_field Skill 独立测试（假数据，无网络，绝不真实下单）。
 */
import {describe, expect, it} from "vitest";
import {createBookSportsFieldSkill, type BookSportsFieldData} from "../../src/skills/sports/bookSportsField";
import type {BookResult, SportsField} from "../../src/client/sports/SportsClient";

const SCENES = [
    {uuid: "u1", sceneName: "气膜馆羽毛球", relatedType: "DEV"},
    {uuid: "u2", sceneName: "综体羽毛球", relatedType: "DEV"},
];

function field(uuid: string, siteName: string, sessions: {uuid: string; start: string; end: string; available: boolean; feeYuan?: number | null}[]): SportsField {
    return {
        uuid, siteName, siteType: "DEV", kindName: "羽毛球", location: "", sceneUuid: "u1",
        reserveStatus: {reserveStatus: "Y", availableRange: []},
        formUuid: "",
        sessions: sessions.map((s) => ({feeYuan: null, ...s})),
        supportPeriod: false,
        bookableWindow: null,
        feeRuleVo: null,
    };
}

const FIELDS: SportsField[] = [
    field("f1", "羽01", [{uuid: "s1", start: "06:00", end: "08:00", available: true, feeYuan: 40}]),
    field("f2", "羽02", [{uuid: "s2", start: "06:00", end: "08:00", available: true, feeYuan: 40}]),
    field("f3", "羽03", [{uuid: "s3", start: "06:00", end: "08:00", available: false}]),
];

function fakeClient(bookImpl?: () => Promise<BookResult>) {
    const calls: {sceneUuid: string; sessionUuid: string; siteUuid: string}[] = [];
    return {
        calls,
        listScenes: async () => SCENES,
        getFieldPage: async (sceneUuid: string) => sceneUuid === "u1" ? FIELDS : [],
        bookSession: async (req: {sceneUuid: string; sessionUuid: string; siteUuid: string}): Promise<BookResult> => {
            calls.push(req);
            return bookImpl ? bookImpl() : {resvIds: ["r1"], orderGenerated: false, freeOrder: true};
        },
    };
}

const exec = (client: ReturnType<typeof fakeClient>, input?: unknown) =>
    createBookSportsFieldSkill(client as never).execute(input) as Promise<{
        success: boolean; data?: BookSportsFieldData; error?: {code: string; message: string};
    }>;

describe("book_sports_field Skill（假数据，不真实下单）", () => {
    it("标了 requiresConfirmation（写操作安全红线）", () => {
        const skill = createBookSportsFieldSkill(fakeClient() as never);
        expect(skill.requiresConfirmation).toBe(true);
    });

    it("指定场地名预约成功，传递正确的 uuid", async () => {
        const client = fakeClient();
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", fieldName: "羽02"});
        expect(r.success).toBe(true);
        expect(client.calls).toHaveLength(1);
        expect(client.calls[0]).toMatchObject({sceneUuid: "u1", siteUuid: "f2", sessionUuid: "s2"});
        expect(r.data).toMatchObject({venue: "气膜馆羽毛球", field: "羽02", time: "06:00-08:00", feeYuan: 40});
    });

    it("不指定场地时自动选第一块空场", async () => {
        const client = fakeClient();
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00"});
        expect(r.success).toBe(true);
        expect(client.calls[0].siteUuid).toBe("f1"); // 羽01 是第一块空场
    });

    it("场馆关键词匹配多个时拒绝，要求更具体（写操作不能订错场馆）", async () => {
        const r = await exec(fakeClient(), {resourceName: "羽毛球", sessionStart: "06:00"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("多个场馆");
    });

    it("该时段无空场时报 NOT_AVAILABLE 并提示可约时段", async () => {
        const r = await exec(fakeClient(), {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "18:00"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_AVAILABLE");
        expect(r.error!.message).toContain("06:00-08:00");
    });

    it("指定的场地在该时段不可订时列出可订场地", async () => {
        const r = await exec(fakeClient(), {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", fieldName: "羽03"});
        expect(r.success).toBe(false);
        expect(r.error!.message).toContain("羽01");
    });

    it("生成待支付订单时如实告知需支付", async () => {
        const client = fakeClient(async () => ({resvIds: ["r1"], orderGenerated: true, freeOrder: false}));
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00"});
        expect(r.success).toBe(true);
        expect(r.data!.orderGenerated).toBe(true);
        expect(r.data!.message).toContain("支付");
        expect(r.data!.message).toContain("40 元");
    });

    it("参数校验：缺 resourceName / 非法 sessionStart / 非法日期", async () => {
        expect((await exec(fakeClient(), {sessionStart: "06:00"})).success).toBe(false);
        expect((await exec(fakeClient(), {resourceName: "气膜馆", sessionStart: "6点"})).success).toBe(false);
        expect((await exec(fakeClient(), {resourceName: "气膜馆", sessionStart: "06:00", date: "明天"})).success).toBe(false);
    });
});
