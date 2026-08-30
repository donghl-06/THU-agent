/**
 * recharge_campus_card Skill 测试（罐头数据，无网络、不真实下单）。
 */
import {describe, expect, it} from "vitest";
import {createRechargeCampusCardSkill, type RechargeCampusCardData} from "../../src/skills/card/rechargeCampusCard";
import {ThuError} from "../../src/client/errors";

type R<T> = {success: boolean; data?: T; error?: {code: string; message: string}};

const ALIPAY_DEEPLINK =
    "alipayqr://platformapi/startapp?saId=10000007&qrcode=https%3A%2F%2Fqr.alipay.com%2Fupx0fakecode001";

const client = {rechargeCampusCardQr: async (_a: number, _alipay: boolean) => ALIPAY_DEEPLINK};

describe("recharge_campus_card Skill", () => {
    it("支付宝通道：深链提取出 https 付款链接", async () => {
        const skill = createRechargeCampusCardSkill(client);
        const r = (await skill.execute({amountYuan: 50})) as R<RechargeCampusCardData>;
        expect(r.success).toBe(true);
        expect(r.data!.payUrl).toBe("https://qr.alipay.com/upx0fakecode001");
        expect(r.data!.method).toBe("alipay");
        expect(r.data!.message).toContain("50");
        expect(r.data!.message).toContain("支付宝");
    });

    it("微信通道：库直接返回的 https 链接原样透传", async () => {
        let gotAlipay: boolean | undefined;
        const skill = createRechargeCampusCardSkill({
            rechargeCampusCardQr: async (_a: number, alipay: boolean) => {
                gotAlipay = alipay;
                return "https://payapp.weixin.qq.com/qr/xxxx";
            },
        });
        const r = (await skill.execute({amountYuan: 20, method: "wechat"})) as R<RechargeCampusCardData>;
        expect(r.success).toBe(true);
        expect(gotAlipay).toBe(false);
        expect(r.data!.payUrl).toBe("https://payapp.weixin.qq.com/qr/xxxx");
        expect(r.data!.message).toContain("微信");
    });

    it("金额与通道透传", async () => {
        let got: [number, boolean] | undefined;
        const skill = createRechargeCampusCardSkill({
            rechargeCampusCardQr: async (a: number, alipay: boolean) => { got = [a, alipay]; return ALIPAY_DEEPLINK; },
        });
        await skill.execute({amountYuan: 10});
        expect(got).toEqual([10, true]);
    });

    it("金额非法（0/负数/字符串/缺失）被拒且不调上游", async () => {
        let called = false;
        const skill = createRechargeCampusCardSkill({
            rechargeCampusCardQr: async () => { called = true; return ALIPAY_DEEPLINK; },
        });
        for (const bad of [0, -5, "50", undefined]) {
            const r = await skill.execute({amountYuan: bad});
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
        expect(called).toBe(false);
    });

    it("低于学校下限（10 元）被拒且不调上游", async () => {
        let called = false;
        const skill = createRechargeCampusCardSkill({
            rechargeCampusCardQr: async () => { called = true; return ALIPAY_DEEPLINK; },
        });
        const r = await skill.execute({amountYuan: 5});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("10");
        expect(called).toBe(false);
    });

    it("超过防手滑上限被拒且不调上游", async () => {
        let called = false;
        const skill = createRechargeCampusCardSkill({
            rechargeCampusCardQr: async () => { called = true; return ALIPAY_DEEPLINK; },
        });
        const r = await skill.execute({amountYuan: 9999});
        expect(r.success).toBe(false);
        expect(r.error!.message).toContain("500");
        expect(called).toBe(false);
    });

    it("method 非法值被拒", async () => {
        const skill = createRechargeCampusCardSkill(client);
        const r = await skill.execute({amountYuan: 10, method: "cash"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
    });

    it("库返回无法识别的链接形式 → UPSTREAM_ERROR", async () => {
        const skill = createRechargeCampusCardSkill({
            rechargeCampusCardQr: async () => "weixin://wxpay/bizpayurl?pr=xxx",
        });
        const r = await skill.execute({amountYuan: 10});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("UPSTREAM_ERROR");
    });

    it("上游 ThuError 透传", async () => {
        const skill = createRechargeCampusCardSkill({
            rechargeCampusCardQr: async () => { throw new ThuError("UPSTREAM_ERROR", "校园卡系统维护中"); },
        });
        const r = await skill.execute({amountYuan: 10});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("UPSTREAM_ERROR");
    });

    it("requiresConfirmation = true（写操作红线）", () => {
        expect(createRechargeCampusCardSkill(client).requiresConfirmation).toBe(true);
    });
});
