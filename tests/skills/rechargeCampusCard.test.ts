/**
 * recharge_campus_card Skill 测试（罐头数据，无网络、不真实下单）。
 */
import {describe, expect, it, vi} from "vitest";
import {createRechargeCampusCardSkill, type RechargeCampusCardData} from "../../src/skills/card/rechargeCampusCard";
import {ThuError} from "../../src/client/errors";

type R<T> = {success: boolean; data?: T; error?: {code: string; message: string}};

const ALIPAY_DEEPLINK =
    "alipayqr://platformapi/startapp?saId=10000007&qrcode=https%3A%2F%2Fqr.alipay.com%2Fupx0fakecode001";

const client = {
    rechargeCampusCardQr: async (_a: number, _alipay: boolean) => ALIPAY_DEEPLINK,
    rechargeCampusCardBank: async (_amount: number) => {},
};

describe("recharge_campus_card Skill", () => {
    it("支付宝通道：深链提取出 https 付款链接", async () => {
        const skill = createRechargeCampusCardSkill(client);
        const r = (await skill.execute({amountYuan: 50})) as R<RechargeCampusCardData>;
        expect(r.success).toBe(true);
        expect(r.data!.payUrl).toBe("https://qr.alipay.com/upx0fakecode001");
        expect(r.data!.method).toBe("alipay");
        expect(r.data!.paymentStatus).toBe("awaiting_payment");
        expect(r.data!.message).toContain("50");
        expect(r.data!.message).toContain("支付宝");
    });

    it("微信通道：库直接返回的 https 链接原样透传", async () => {
        let gotAlipay: boolean | undefined;
        const skill = createRechargeCampusCardSkill({
            ...client,
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
            ...client,
            rechargeCampusCardQr: async (a: number, alipay: boolean) => { got = [a, alipay]; return ALIPAY_DEEPLINK; },
        });
        await skill.execute({amountYuan: 10});
        expect(got).toEqual([10, true]);
    });

    it("金额非法（0/负数/字符串/缺失）被拒且不调上游", async () => {
        let called = false;
        const skill = createRechargeCampusCardSkill({
            ...client,
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
            ...client,
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
            ...client,
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
            ...client,
            rechargeCampusCardQr: async () => "weixin://wxpay/bizpayurl?pr=xxx",
        });
        const r = await skill.execute({amountYuan: 10});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("UPSTREAM_ERROR");
    });

    it("上游 ThuError 透传", async () => {
        const skill = createRechargeCampusCardSkill({
            ...client,
            rechargeCampusCardQr: async () => { throw new ThuError("UPSTREAM_ERROR", "校园卡系统维护中"); },
        });
        const r = await skill.execute({amountYuan: 10});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("UPSTREAM_ERROR");
    });

    it("requiresConfirmation = true（写操作红线）", () => {
        expect(createRechargeCampusCardSkill(client).requiresConfirmation).toBe(true);
    });

    it.each([10, 100, 200])("银行卡直充 %i 元只调用一次银行通道，不生成二维码或声称到账", async (amountYuan) => {
        const bank = vi.fn().mockResolvedValue(undefined);
        const qr = vi.fn();
        const skill = createRechargeCampusCardSkill({rechargeCampusCardBank: bank, rechargeCampusCardQr: qr});
        const result = await skill.execute({amountYuan, method: "bank"});
        expect(bank).toHaveBeenCalledTimes(1);
        expect(bank).toHaveBeenCalledWith(amountYuan);
        expect(qr).not.toHaveBeenCalled();
        expect(result).toMatchObject({success: true, data: {amountYuan, method: "bank", paymentStatus: "submitted"}});
        expect(result.data).not.toHaveProperty("payUrl");
        expect((result.data as RechargeCampusCardData).message).toContain("尚未核实扣款和到账");
    });

    it.each([undefined, null, "100", NaN, Infinity, -1, 0, 5, 10.12, 100.001, 201, 501])(
        "银行卡金额 %s 非法时不会调用任何付款通道", async (amountYuan) => {
            const bank = vi.fn();
            const qr = vi.fn();
            const result = await createRechargeCampusCardSkill({rechargeCampusCardBank: bank, rechargeCampusCardQr: qr})
                .execute({amountYuan, method: "bank"});
            expect(result.error?.code).toBe("INVALID_INPUT");
            expect(bank).not.toHaveBeenCalled();
            expect(qr).not.toHaveBeenCalled();
        },
    );

    it("省略支付方式保留支付宝默认值，不会转成直接银行卡扣款", async () => {
        const bank = vi.fn();
        const qr = vi.fn().mockResolvedValue(ALIPAY_DEEPLINK);
        const result = await createRechargeCampusCardSkill({rechargeCampusCardBank: bank, rechargeCampusCardQr: qr})
            .execute({amountYuan: 500});
        expect(result.success).toBe(true);
        expect(qr).toHaveBeenCalledTimes(1);
        expect(qr).toHaveBeenCalledWith(500, true);
        expect(bank).not.toHaveBeenCalled();
    });

    it.each(["TIMEOUT", "NETWORK_ERROR", "UPSTREAM_ERROR", "LIB_ERROR", "UNKNOWN"] as const)(
        "银行卡 %s 返回结果未知，不重试、不切换扫码、不泄露原始响应", async (code) => {
            const bank = vi.fn().mockRejectedValue(new ThuError(code, "synthetic-secret-response，请重试"));
            const qr = vi.fn();
            const result = await createRechargeCampusCardSkill({rechargeCampusCardBank: bank, rechargeCampusCardQr: qr})
                .execute({amountYuan: 100, method: "bank"});
            expect(result).toMatchObject({success: false, error: {code: "PAYMENT_STATUS_UNKNOWN"}});
            expect(result.error?.message).toContain("不要自动重试");
            expect(JSON.stringify(result)).not.toContain("synthetic-secret-response");
            expect(bank).toHaveBeenCalledTimes(1);
            expect(qr).not.toHaveBeenCalled();
        },
    );

    it.each(["AUTH_REQUIRED", "AUTH_FAILED"] as const)("银行卡 %s 引导完成登录", async (code) => {
        const bank = vi.fn().mockRejectedValue(new ThuError(code, "synthetic-auth-response"));
        const result = await createRechargeCampusCardSkill({...client, rechargeCampusCardBank: bank})
            .execute({amountYuan: 100, method: "bank"});
        expect(result.error?.code).toBe(code);
        expect(result.error?.message).toContain("请先完成登录");
        expect(bank).toHaveBeenCalledTimes(1);
    });
});
