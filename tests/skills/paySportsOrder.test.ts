/**
 * pay_sports_order Skill 测试（罐头数据，无网络、不真实下单）。
 * 数据形状复刻 2026-08-30 真实链路探测结果（scripts/probe-sports-pay.ts）。
 */
import {describe, expect, it} from "vitest";
import {createPaySportsOrderSkill, type PaySportsOrderData} from "../../src/skills/sports/paySportsOrder";
import type {SportsOrder} from "../../src/client/sports/SportsClient";
import {ThuError} from "../../src/client/errors";

type R<T> = {success: boolean; data?: T; error?: {code: string; message: string}};

/** 一笔待支付线上订单（列表层形状） */
function unpaidOrder(over: Partial<SportsOrder> = {}): SportsOrder {
    return {
        uuid: "order-uuid-1",
        orderNo: "623457",
        orderStatus: 1,
        payType: 1,
        payableAmount: 4000,
        orderCreateTime: "2026-08-30 10:00:00",
        paymentDeadline: "2026-08-30 11:00:00",
        orderDetails: [{
            resvReserveVo: {uuid: "resv-uuid-1", resvBeginTime: "2026-08-31 06:00:00", resvEndTime: "2026-08-31 08:00:00"},
            timeRange: {startTime: "2026-08-31 06:00:00", endTime: "2026-08-31 08:00:00"},
            siteInfo: {siteName: "羽01", siteType: "DEV"},
        }],
        ...over,
    };
}

/** 全链正常的假客户端；overrides 可逐方法替换 */
function fakeClient(overrides: Record<string, unknown> = {}) {
    return {
        listMyOrders: async () => [unpaidOrder()],
        getOrderDetail: async () => ({
            uuid: "order-uuid-1",
            orderStatus: "TO_BE_PAID",
            payType: "PAY_ONLINE",
            payableAmount: 4000,
            reservations: [{siteUuid: "site-1", siteType: "DEV"}],
        }),
        getPayChannels: async () => [{channelId: "tsinghua_pc_9", name: "清华气膜馆PC支付", property: 0}],
        placePayOrder: async () => ({
            displayMode: "qr_code",
            displayContent: "https://pay.example.com/qr/abc123",
        }),
        ...overrides,
    };
}

describe("pay_sports_order Skill", () => {
    it("单笔待支付订单 → 返回二维码链接", async () => {
        const skill = createPaySportsOrderSkill(fakeClient());
        const r = (await skill.execute({})) as R<PaySportsOrderData>;
        expect(r.success).toBe(true);
        expect(r.data!.displayMode).toBe("qr_code");
        expect(r.data!.payUrl).toBe("https://pay.example.com/qr/abc123");
        expect(r.data!.amountYuan).toBe(40);
        expect(r.data!.field).toBe("羽01");
        expect(r.data!.message).toContain("40");
    });

    it("displayMode=form 时返回表单 HTML 而非链接", async () => {
        const skill = createPaySportsOrderSkill(fakeClient({
            placePayOrder: async () => ({displayMode: "form", displayContent: "<form action='https://fa-online.tsinghua.edu.cn/x'>…</form>"}),
        }));
        const r = (await skill.execute({})) as R<PaySportsOrderData>;
        expect(r.success).toBe(true);
        expect(r.data!.payFormHtml).toContain("fa-online");
        expect(r.data!.payUrl).toBeUndefined();
        expect(r.data!.message).toContain("学校支付平台");
    });

    it("没有待支付订单 → NOT_FOUND", async () => {
        const skill = createPaySportsOrderSkill(fakeClient({listMyOrders: async () => []}));
        const r = await skill.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
    });

    it("已支付/已取消/线下支付的订单不算待支付", async () => {
        const orders = [
            unpaidOrder({uuid: "a", orderStatus: 4}),            // 已支付
            unpaidOrder({uuid: "b", orderStatus: 8}),            // 已取消
            unpaidOrder({uuid: "c", orderStatus: 16}),           // 超时
            unpaidOrder({uuid: "d", orderStatus: 1, payType: 2}),// 线下支付
        ];
        const skill = createPaySportsOrderSkill(fakeClient({listMyOrders: async () => orders}));
        const r = await skill.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
    });

    it("多笔待支付且无关键词 → AMBIGUOUS 列出候选", async () => {
        const orders = [
            unpaidOrder({uuid: "a"}),
            unpaidOrder({uuid: "b", orderDetails: [{
                resvReserveVo: {uuid: "r2"},
                timeRange: {startTime: "2026-08-31 18:00:00", endTime: "2026-08-31 20:00:00"},
                siteInfo: {siteName: "羽03", siteType: "DEV"},
            }]}),
        ];
        const skill = createPaySportsOrderSkill(fakeClient({listMyOrders: async () => orders}));
        const r = await skill.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("AMBIGUOUS");
        expect(r.error!.message).toContain("羽01");
        expect(r.error!.message).toContain("羽03");
    });

    it("关键词选中其中一笔", async () => {
        const orders = [
            unpaidOrder({uuid: "a"}),
            unpaidOrder({uuid: "b", orderDetails: [{
                resvReserveVo: {uuid: "r2"},
                timeRange: {startTime: "2026-08-31 18:00:00", endTime: "2026-08-31 20:00:00"},
                siteInfo: {siteName: "羽03", siteType: "DEV"},
            }]}),
        ];
        let paidUuid = "";
        const skill = createPaySportsOrderSkill(fakeClient({
            listMyOrders: async () => orders,
            placePayOrder: async (uuid: string) => { paidUuid = uuid; return {displayMode: "url", displayContent: "https://x"}; },
        }));
        const r = (await skill.execute({keyword: "羽03"})) as R<PaySportsOrderData>;
        expect(r.success).toBe(true);
        expect(paidUuid).toBe("b");
    });

    it("关键词无匹配 → NOT_FOUND 并提示现有候选", async () => {
        const skill = createPaySportsOrderSkill(fakeClient());
        const r = await skill.execute({keyword: "篮01"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
        expect(r.error!.message).toContain("羽01");
    });

    it("详情复核非 TO_BE_PAID（竞态：刚被取消/超时）→ NOT_AVAILABLE", async () => {
        for (const st of ["CANCEL", "PAID", "PAID_TIMEOUT"]) {
            const skill = createPaySportsOrderSkill(fakeClient({
                getOrderDetail: async () => ({orderStatus: st, reservations: [{siteUuid: "s", siteType: "DEV"}]}),
            }));
            const r = await skill.execute({});
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("NOT_AVAILABLE");
        }
    });

    it("无可用支付渠道 → NOT_AVAILABLE", async () => {
        const skill = createPaySportsOrderSkill(fakeClient({getPayChannels: async () => []}));
        const r = await skill.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_AVAILABLE");
    });

    it("上游 ThuError 透传", async () => {
        const skill = createPaySportsOrderSkill(fakeClient({
            listMyOrders: async () => { throw new ThuError("MAINTENANCE", "体育系统维护中"); },
        }));
        const r = await skill.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("MAINTENANCE");
    });

    it("keyword 类型校验", async () => {
        const skill = createPaySportsOrderSkill(fakeClient());
        const r = await skill.execute({keyword: 123});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
    });

    it("requiresConfirmation = true（写操作红线）", () => {
        expect(createPaySportsOrderSkill(fakeClient()).requiresConfirmation).toBe(true);
    });
});
