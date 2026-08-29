/**
 * Skill: recharge_electricity —— 发起宿舍电费充值（写操作，生成待支付订单）。
 *
 * 安全红线（plan4ai.md）：requiresConfirmation = true，Harness 必须先向用户
 * 展示操作详情并拿到明确同意才会执行到这里。
 *
 * 支付模型（扫码半自动，与 Step 19 路线一致）：
 * 本 skill 只负责下单，拿到支付宝 payCode 拼成二维码链接返回；
 * 用户用手机支付宝扫码完成支付。扫码前钱不动，订单会自动过期。
 * 充值的房间是当前账号绑定的宿舍（上游表单自带 louhao/room，不支持给别人充）。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface RechargeElectricityData {
    amountYuan: number;
    /** 支付宝扫码付款链接（完整 URL，可直接生成二维码或发给用户） */
    payUrl: string;
    message: string;
}

type EleRecharger = Pick<ThuClient, "getEleRechargePayCode">;

/** 金额上限：电费充值没有业务理由一次充很多，设个防手滑的硬上限 */
const MAX_AMOUNT = 500;

export function createRechargeElectricitySkill(client: EleRecharger): Skill {
    return {
        name: "recharge_electricity",
        description:
            "宿舍电费充值（写操作，会生成真实待支付订单）。输入充值金额（元），" +
            "返回支付宝扫码付款链接，用户用手机支付宝扫码付款后电费到账。" +
            "调用前必须向用户确认金额，得到明确同意后才调用。" +
            "只能充当前账号绑定的宿舍，不能给别人充。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                amountYuan: {
                    type: "number",
                    description: `充值金额（元），必须大于 0，不超过 ${MAX_AMOUNT}`,
                },
            },
            required: ["amountYuan"],
        },

        async execute(input: unknown): Promise<SkillResult<RechargeElectricityData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.amountYuan !== "number" || !Number.isFinite(raw.amountYuan)) {
                return fail("INVALID_INPUT", "amountYuan 必填：充值金额（元），数字");
            }
            const amount = raw.amountYuan;
            if (amount <= 0) {
                return fail("INVALID_INPUT", "充值金额必须大于 0");
            }
            if (amount > MAX_AMOUNT) {
                return fail("INVALID_INPUT", `单次最多充 ${MAX_AMOUNT} 元（防手滑上限），请分多次或确认后重试`);
            }

            try {
                const payCode = await client.getEleRechargePayCode(amount);
                const payUrl = `https://qr.alipay.com/${payCode}`;
                return ok({
                    amountYuan: amount,
                    payUrl,
                    message: `已生成 ${amount} 元电费充值订单。请用手机支付宝扫码付款：${payUrl}` +
                        `（把这个链接转成二维码或直接发给用户均可）。不付款订单会自动过期，钱不会动。`,
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
