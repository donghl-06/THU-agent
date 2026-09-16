/**
 * Skill: recharge_campus_card —— 校园卡充值（银行卡直充或扫码付款）。
 *
 * bank 直接提交银行卡扣款；alipay/wechat 生成二维码，手机确认后才扣款。
 * 所有通道保留 requiresConfirmation = true，bank 必须显式选择。
 *
 * 通道说明（库实现，card.js）：
 * - alipay → 库返回 alipayqr:// 深链，内嵌 https://qr.alipay.com/<payCode>，
 *   这里提取出 https 链接（Web UI 出二维码、CLI 打印链接都能用）
 * - wechat → 库直接返回微信扫码链接
 */
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

interface RechargeCampusCardBase {
    amountYuan: number;
    message: string;
}

export type RechargeCampusCardData = RechargeCampusCardBase & (
    | {method: "bank"; paymentStatus: "submitted"; payUrl?: never}
    | {method: "alipay" | "wechat"; paymentStatus: "awaiting_payment"; payUrl: string}
);

/** 防手滑上限（元）：校园卡单次充值一般不过百，500 足够宽裕 */
const MAX_AMOUNT = 500;
/** 银行卡直充沿用上游 App 的 200 元上限；仅开放整数元，避免底层分单位截断。 */
const MAX_BANK_AMOUNT = 200;
/** 单次下限（元）：上游硬性要求（2026-08-30 实测，<10 返回 cardpay.inputtxamtgreater10） */
const MIN_AMOUNT = 10;

type CardRecharger = {
    rechargeCampusCardQr: (amount: number, alipay: boolean) => Promise<string>;
    rechargeCampusCardBank: (amount: number) => Promise<void>;
};

/** 从 alipayqr:// 深链提取内嵌的 https://qr.alipay.com/<payCode>；本就是 https 链接则原样返回 */
function toHttpsPayUrl(raw: string): string | undefined {
    if (raw.startsWith("https://")) return raw;
    const m = /qrcode=(https?%3A%2F%2F[^&\s]+)/i.exec(raw);
    if (m) return decodeURIComponent(m[1]);
    return undefined;
}

export function createRechargeCampusCardSkill(client: CardRecharger): Skill {
    return {
        name: "recharge_campus_card",
        description:
            "为当前用户的校园卡充值。method=bank 直接从校园卡系统绑定的银行卡扣款，无需扫码；" +
            "仅在用户明确选择银行卡并授权本次金额后使用，不可自行把扫码充值改成银行卡扣款。" +
            "method=alipay（默认）或 wechat 生成付款二维码，手机确认后才扣款。" +
            "bank 返回 paymentStatus=submitted 只表示已提交，不能声称已扣款或到账；" +
            "应查询校园卡余额核对，结果不明时不得自动重试或切换通道重复付款。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                amountYuan: {
                    type: "number",
                    description: `充值金额（元）：bank 为 ${MIN_AMOUNT}~${MAX_BANK_AMOUNT} 的整数；扫码为 ${MIN_AMOUNT}~${MAX_AMOUNT}`,
                },
                method: {
                    type: "string",
                    enum: ["alipay", "wechat", "bank"],
                    description: "支付通道：alipay=支付宝扫码（默认），wechat=微信扫码，bank=绑定银行卡直接扣款（需明确授权）",
                },
            },
            required: ["amountYuan"],
        },

        async execute(input: unknown): Promise<SkillResult<RechargeCampusCardData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.amountYuan !== "number" || !Number.isFinite(raw.amountYuan) || raw.amountYuan <= 0) {
                return fail("INVALID_INPUT", "amountYuan 必须是正数（元）");
            }
            if (raw.amountYuan < MIN_AMOUNT) {
                return fail("INVALID_INPUT", `校园卡单次充值最少 ${MIN_AMOUNT} 元（学校规定的下限）。`);
            }
            if (raw.amountYuan > MAX_AMOUNT) {
                return fail(
                    "INVALID_INPUT",
                    `单次充值上限 ${MAX_AMOUNT} 元（防手滑）。要充更多请分多次。`,
                );
            }
            if (raw.method !== undefined && raw.method !== "alipay" && raw.method !== "wechat" && raw.method !== "bank") {
                return fail("INVALID_INPUT", "method 只能是 alipay（支付宝）、wechat（微信）或 bank（银行卡）");
            }
            const method = (raw.method as "alipay" | "wechat" | "bank" | undefined) ?? "alipay";
            if (method === "bank" && (!Number.isInteger(raw.amountYuan) || raw.amountYuan > MAX_BANK_AMOUNT)) {
                return fail("INVALID_INPUT", `银行卡单次充值金额必须是 ${MIN_AMOUNT}~${MAX_BANK_AMOUNT} 的整数（元）。`);
            }

            try {
                if (method === "bank") {
                    await client.rechargeCampusCardBank(raw.amountYuan);
                    return ok({
                        amountYuan: raw.amountYuan,
                        method,
                        paymentStatus: "submitted",
                        message: `已提交 ${raw.amountYuan} 元校园卡银行卡充值请求，无需扫码。` +
                            "尚未核实扣款和到账，请查询校园卡余额并核对充值记录；不要自动重复付款。",
                    });
                }
                const rawUrl = await client.rechargeCampusCardQr(raw.amountYuan, method === "alipay");
                const payUrl = toHttpsPayUrl(rawUrl);
                if (!payUrl) {
                    return fail("UPSTREAM_ERROR", `校园卡充值返回了无法识别的支付链接形式：${rawUrl.slice(0, 50)}…`);
                }
                const methodName = method === "alipay" ? "支付宝" : "微信";
                return ok({
                    amountYuan: raw.amountYuan,
                    method,
                    paymentStatus: "awaiting_payment",
                    payUrl,
                    message: `已生成校园卡充值二维码（${raw.amountYuan} 元，${methodName}），用手机${methodName}扫码付款。`,
                });
            } catch (e) {
                if (method === "bank") {
                    if (e instanceof ThuError && (e.code === "AUTH_REQUIRED" || e.code === "AUTH_FAILED")) {
                        return fail(e.code, "校园卡登录认证未完成，请先完成登录。本次未自动重试充值。");
                    }
                    // 连接中断、业务异常均可能发生在扣款之后；不透传底层的通用“重试”建议。
                    return fail("PAYMENT_STATUS_UNKNOWN", "银行卡充值结果未能确认。请先核对银行卡扣款及校园卡余额、充值记录；" +
                        "不要自动重试或改用其他通道重复付款。");
                }
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
