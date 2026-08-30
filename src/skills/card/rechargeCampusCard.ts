/**
 * Skill: recharge_campus_card —— 校园卡充值（生成微信/支付宝扫码二维码）。
 *
 * 资金安全：本 Skill 只生成支付二维码，不移动资金——用户用手机扫码并
 * 亲自确认后才扣款。即使如此仍是"发起充值"动作，requiresConfirmation = true。
 *
 * 通道说明（库实现，card.js）：
 * - alipay → 库返回 alipayqr:// 深链，内嵌 https://qr.alipay.com/<payCode>，
 *   这里提取出 https 链接（Web UI 出二维码、CLI 打印链接都能用）
 * - wechat → 库直接返回微信扫码链接
 */
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface RechargeCampusCardData {
    amountYuan: number;
    method: "alipay" | "wechat";
    /** 扫码付款链接（https），Web UI 出二维码 */
    payUrl: string;
    message: string;
}

/** 防手滑上限（元）：校园卡单次充值一般不过百，500 足够宽裕 */
const MAX_AMOUNT = 500;
/** 单次下限（元）：上游硬性要求（2026-08-30 实测，<10 返回 cardpay.inputtxamtgreater10） */
const MIN_AMOUNT = 10;

type CardRecharger = {
    rechargeCampusCardQr: (amount: number, alipay: boolean) => Promise<string>;
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
            "校园卡充值：生成微信或支付宝的扫码付款二维码，用户用手机扫码确认后才扣款。" +
            "用于“给校园卡充钱/饭卡充值”等场景。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                amountYuan: {
                    type: "number",
                    description: `充值金额（元），${MIN_AMOUNT}~${MAX_AMOUNT} 之间（学校规定的单次下限是 ${MIN_AMOUNT} 元）`,
                },
                method: {
                    type: "string",
                    enum: ["alipay", "wechat"],
                    description: "支付通道：alipay=支付宝（默认），wechat=微信",
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
            if (raw.method !== undefined && raw.method !== "alipay" && raw.method !== "wechat") {
                return fail("INVALID_INPUT", "method 只能是 alipay（支付宝）或 wechat（微信）");
            }
            const method = (raw.method as "alipay" | "wechat" | undefined) ?? "alipay";

            try {
                const rawUrl = await client.rechargeCampusCardQr(raw.amountYuan, method === "alipay");
                const payUrl = toHttpsPayUrl(rawUrl);
                if (!payUrl) {
                    return fail("UPSTREAM_ERROR", `校园卡充值返回了无法识别的支付链接形式：${rawUrl.slice(0, 50)}…`);
                }
                const methodName = method === "alipay" ? "支付宝" : "微信";
                return ok({
                    amountYuan: raw.amountYuan,
                    method,
                    payUrl,
                    message: `已生成校园卡充值二维码（${raw.amountYuan} 元，${methodName}），用手机${methodName}扫码付款。`,
                });
            } catch (e) {
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
