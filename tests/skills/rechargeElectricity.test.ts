/**
 * 电费充值技能测试（罐头数据，无网络、不真实下单）。
 */
import {describe, expect, it} from "vitest";
import {createRechargeElectricitySkill, type RechargeElectricityData} from "../../src/skills/dorm/rechargeElectricity";
import {ThuError} from "../../src/client/errors";

type R<T> = {success: boolean; data?: T; error?: {code: string; message: string}};

const client = {getEleRechargePayCode: async (_money: number) => "upx0fakecode000000000001"};

describe("recharge_electricity Skill", () => {
    it("正常金额返回扫码付款链接", async () => {
        const skill = createRechargeElectricitySkill(client);
        const r = (await skill.execute({amountYuan: 50})) as R<RechargeElectricityData>;
        expect(r.success).toBe(true);
        expect(r.data!.payUrl).toBe("https://qr.alipay.com/upx0fakecode000000000001");
        expect(r.data!.message).toContain("50");
        expect(r.data!.message).toContain("支付宝");
    });

    it("金额透传给上游", async () => {
        let got = 0;
        const skill = createRechargeElectricitySkill({
            getEleRechargePayCode: async (m: number) => { got = m; return "x"; },
        });
        await skill.execute({amountYuan: 0.01});
        expect(got).toBe(0.01);
    });

    it("金额非法（0/负数/非数字）被拒", async () => {
        const skill = createRechargeElectricitySkill(client);
        for (const bad of [0, -5, "50", undefined]) {
            const r = await skill.execute({amountYuan: bad});
            expect(r.success).toBe(false);
            expect(r.error!.code).toBe("INVALID_INPUT");
        }
    });

    it("超过防手滑上限被拒且不下单", async () => {
        let called = false;
        const skill = createRechargeElectricitySkill({
            getEleRechargePayCode: async () => { called = true; return "x"; },
        });
        const r = await skill.execute({amountYuan: 9999});
        expect(r.success).toBe(false);
        expect(r.error!.message).toContain("500");
        expect(called).toBe(false);
    });

    it("requiresConfirmation = true（写操作红线）", () => {
        expect(createRechargeElectricitySkill(client).requiresConfirmation).toBe(true);
    });

    it("上游错误透传", async () => {
        const failing = createRechargeElectricitySkill({
            getEleRechargePayCode: async () => { throw new ThuError("UPSTREAM_ERROR", "学校系统维护中"); },
        });
        const r = await failing.execute({amountYuan: 10});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("UPSTREAM_ERROR");
    });
});
