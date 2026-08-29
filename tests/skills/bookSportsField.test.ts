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

function field(uuid: string, siteName: string, sessions: {uuid: string; start: string; end: string; available: boolean; feeYuan?: number | null; payType?: string}[]): SportsField {
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
    field("f4", "羽04", [{uuid: "s4", start: "20:00", end: "22:00", available: true, feeYuan: 40, payType: "PAY_ONLINE"}]),
    field("f5", "羽05", [{uuid: "s5", start: "12:00", end: "13:00", available: true, feeYuan: 0}]),
];

// 付费场次的合法调用都带 payType（用户已选）
const PAID = {payType: "PAY_ONLINE"};

function fakeClient(opts: {bookImpl?: () => Promise<BookResult>; captcha?: boolean} = {}) {
    const calls: {sceneUuid: string; sessionUuid: string; siteUuid: string; captcha?: string; payType?: string}[] = [];
    return {
        calls,
        listScenes: async () => SCENES,
        getFieldPage: async (sceneUuid: string) => sceneUuid === "u1" ? FIELDS : [],
        isCaptchaEnabled: async () => opts.captcha ?? false,
        getDragCaptcha: async () => ({token: "t", secretKey: "k", backgroundBase64: "bg", jigsawBase64: "jg"}),
        checkDragCaptcha: async (_cap: unknown, _x: number) => true,
        buildCaptchaValue: (_cap: unknown, x: number) => `captcha-x${x}`,
        bookSession: async (req: {sceneUuid: string; sessionUuid: string; siteUuid: string; captcha?: string; payType?: string}): Promise<BookResult> => {
            calls.push(req);
            return opts.bookImpl ? opts.bookImpl() : {resvIds: ["r1"], orderGenerated: false, freeOrder: true};
        },
    };
}

const exec = (client: ReturnType<typeof fakeClient>, input?: unknown, captchaSolver?: (ctx: {backgroundBase64: string; jigsawBase64: string; tryX: (x: number) => Promise<boolean>}) => Promise<number>) =>
    createBookSportsFieldSkill(client as never, captchaSolver ? {captchaSolver} : {}).execute(input) as Promise<{
        success: boolean; data?: BookSportsFieldData; error?: {code: string; message: string};
    }>;

describe("book_sports_field Skill（假数据，不真实下单）", () => {
    it("标了 requiresConfirmation（写操作安全红线）", () => {
        const skill = createBookSportsFieldSkill(fakeClient() as never);
        expect(skill.requiresConfirmation).toBe(true);
    });

    it("指定场地名预约成功，传递正确的 uuid", async () => {
        const client = fakeClient();
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", fieldName: "羽02", ...PAID});
        expect(r.success).toBe(true);
        expect(client.calls).toHaveLength(1);
        expect(client.calls[0]).toMatchObject({sceneUuid: "u1", siteUuid: "f2", sessionUuid: "s2"});
        expect(r.data).toMatchObject({venue: "气膜馆羽毛球", field: "羽02", time: "06:00-08:00", feeYuan: 40});
    });

    it("不指定场地时自动选第一块空场", async () => {
        const client = fakeClient();
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", ...PAID});
        expect(r.success).toBe(true);
        expect(client.calls[0].siteUuid).toBe("f1"); // 羽01 是第一块空场
    });

    it("场馆关键词匹配多个时拒绝，要求更具体（写操作不能订错场馆）", async () => {
        const r = await exec(fakeClient(), {resourceName: "羽毛球", sessionStart: "06:00", ...PAID});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("多个场馆");
    });

    it("该时段无空场时报 NOT_AVAILABLE 并提示可约时段", async () => {
        const r = await exec(fakeClient(), {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "18:00", ...PAID});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_AVAILABLE");
        expect(r.error!.message).toContain("06:00-08:00");
    });

    it("指定的场地在该时段不可订时列出可订场地", async () => {
        const r = await exec(fakeClient(), {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", fieldName: "羽03", ...PAID});
        expect(r.success).toBe(false);
        expect(r.error!.message).toContain("羽01");
    });

    it("生成待支付订单时如实告知需支付", async () => {
        const client = fakeClient({bookImpl: async () => ({resvIds: ["r1"], orderGenerated: true, freeOrder: false})});
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", ...PAID});
        expect(r.success).toBe(true);
        expect(r.data!.orderGenerated).toBe(true);
        expect(r.data!.message).toContain("支付");
        expect(r.data!.message).toContain("40 元");
    });

    it("付费场次不传 payType 时返回 PAY_TYPE_REQUIRED，让模型先问用户，不下单", async () => {
        const client = fakeClient();
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("PAY_TYPE_REQUIRED");
        expect(r.error!.message).toContain("40 元");
        expect(client.calls).toHaveLength(0);
    });

    it("付费场次即使场次数据标了默认支付方式，也仍然要先问用户", async () => {
        const client = fakeClient();
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "20:00"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("PAY_TYPE_REQUIRED");
        expect(client.calls).toHaveLength(0);
    });

    it("用户选择的支付方式原样传给下单（覆盖场次默认标注）", async () => {
        const client = fakeClient();
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "20:00", payType: "PAY_OFFLINE"});
        expect(r.success).toBe(true);
        expect(client.calls[0].payType).toBe("PAY_OFFLINE"); // 场次标的是 PAY_ONLINE，用户说了算
        expect(r.data!.payType).toBe("PAY_OFFLINE");
    });

    it("免费场次不问支付方式直接下单", async () => {
        const client = fakeClient();
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "12:00"});
        expect(r.success).toBe(true);
        expect(client.calls).toHaveLength(1);
        expect(r.data!.message).toContain("免费");
    });

    it("payType 只能是 PAY_ONLINE / PAY_OFFLINE", async () => {
        const r = await exec(fakeClient(), {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", payType: "现金"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
    });

    it("验证码开启且没有过码器时拒绝执行（CAPTCHA_REQUIRED），不下单", async () => {
        const client = fakeClient({captcha: true});
        const r = await exec(client, {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", ...PAID});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("CAPTCHA_REQUIRED");
        expect(client.calls).toHaveLength(0);
    });

    it("验证码开启时走过码流程：求解器用 tryX 找到 X，captcha 值传给下单", async () => {
        const client = fakeClient({captcha: true});
        const solverCalls: unknown[] = [];
        const r = await exec(
            client,
            {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", ...PAID},
            async (ctx) => {
                solverCalls.push(ctx.backgroundBase64);
                // 模拟求解器：逐个候选验证，152 通过
                expect(await ctx.tryX(100)).toBe(true); // 假 client 全部通过
                return 152;
            },
        );
        expect(r.success).toBe(true);
        expect(solverCalls).toHaveLength(1);
        expect(client.calls[0].captcha).toBe("captcha-x152");
    });

    it("求解器连续失败时报 CAPTCHA_FAILED，不下单", async () => {
        const client = fakeClient({captcha: true});
        const r = await exec(
            client,
            {resourceName: "气膜馆", date: "2026-08-30", sessionStart: "06:00", ...PAID},
            async () => {
                throw new Error("3 个候选均未通过验证");
            },
        );
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("CAPTCHA_FAILED");
        expect(client.calls).toHaveLength(0);
    });

    it("参数校验：缺 resourceName / 非法 sessionStart / 非法日期", async () => {
        expect((await exec(fakeClient(), {sessionStart: "06:00", ...PAID})).success).toBe(false);
        expect((await exec(fakeClient(), {resourceName: "气膜馆", sessionStart: "6点", ...PAID})).success).toBe(false);
        expect((await exec(fakeClient(), {resourceName: "气膜馆", sessionStart: "06:00", date: "明天", ...PAID})).success).toBe(false);
    });
});
