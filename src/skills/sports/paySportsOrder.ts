/**
 * Skill: pay_sports_order —— 为"待支付的体育场订单"生成支付方式（二维码/链接/表单）。
 *
 * 链路（全部经 2026-08-30 真实链路探测验证，见 scripts/probe-sports-pay.ts）：
 *   listMyOrders → 筛待支付线上订单 → getOrderDetail 复核状态
 *   → getPayChannels 取渠道 → placePayOrder 拿 displayMode/displayContent
 *
 * 资金安全：本 Skill 只生成支付参数，不移动资金——钱只在用户用手机
 * 扫码/跳转后亲自确认时才扣。即使如此，它仍是"发起支付"动作，
 * requiresConfirmation = true，由 Harness 先向用户确认。
 *
 * displayMode 三种形态（前端同款约定）：
 * - qr_code / qr_code_url → payUrl 是二维码内容，Web UI 直接出码
 * - url                   → payUrl 是跳转链接
 * - form                  → payFormHtml 是自动提交表单（POST 到学校财务平台
 *                           fa-online.tsinghua.edu.cn，气膜馆渠道实测就是这种），
 *                           Web UI 渲染"前往支付"按钮在用户浏览器里打开
 */
import type {SportsClient, SportsOrder} from "../../client/sports/SportsClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface PaySportsOrderData {
    orderNo?: string;
    field: string;
    time: string;
    amountYuan: number | null;
    /** 支付截止 "yyyy-MM-dd HH:mm:ss" */
    paymentDeadline?: string;
    displayMode: string;
    /** 二维码内容或跳转链接（displayMode 为 qr_code/qr_code_url/url 时） */
    payUrl?: string;
    /** 自动提交的支付表单 HTML（displayMode 为 form 时） */
    payFormHtml?: string;
    message: string;
}

type SportsPayer = Pick<
    SportsClient,
    "listMyOrders" | "getOrderDetail" | "getPayChannels" | "placePayOrder"
>;

/** 列表层数字状态码：1=待支付 2=支付中（2026-08-30 实测；权威判定以详情字符串为准） */
const UNPAID_LIST_STATUS = new Set([1, 2]);

/** 订单的一句话描述（列表没有场景名，场地名+时间+金额足够区分） */
function describe(o: SportsOrder): string {
    const d = o.orderDetails?.[0];
    const field = d?.siteInfo?.siteName ?? "未知场地";
    const begin = d?.timeRange?.startTime ?? d?.resvReserveVo?.resvBeginTime ?? "?";
    const end = d?.timeRange?.endTime ?? d?.resvReserveVo?.resvEndTime ?? "?";
    const amount = typeof o.payableAmount === "number" ? `，${o.payableAmount / 100} 元` : "";
    return `${field} ${begin}~${end.slice(11)}${amount}`;
}

export function createPaySportsOrderSkill(client: SportsPayer): Skill {
    return {
        name: "pay_sports_order",
        description:
            "为待支付的体育场馆订单生成支付方式（扫码/链接/跳转学校支付平台），" +
            "只生成支付参数、不扣钱，用户在手机上确认后才真正付款。" +
            "用于用户说“付一下体育场地的钱/我的体育订单怎么付款”等场景。" +
            "多笔待支付时会返回候选列表让用户指认。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                keyword: {
                    type: "string",
                    description:
                        "定位订单的关键词（场地名/日期，如“羽03”或“08-31”）；" +
                        "只有一笔待支付订单时可省略",
                },
            },
        },

        async execute(input: unknown): Promise<SkillResult<PaySportsOrderData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (raw.keyword !== undefined && typeof raw.keyword !== "string") {
                return fail("INVALID_INPUT", "keyword 必须是字符串");
            }
            const keyword = typeof raw.keyword === "string" ? raw.keyword.trim() : "";

            try {
                const orders = await client.listMyOrders(20);
                const unpaid = orders.filter((o) =>
                    o.orderStatus !== undefined && UNPAID_LIST_STATUS.has(o.orderStatus) &&
                    o.payType === 1,
                );
                if (unpaid.length === 0) {
                    return fail(
                        "NOT_FOUND",
                        "没有待支付的体育场订单。订场时在 book_sports_field 里选线上支付（PAY_ONLINE）才会生成待支付订单。",
                    );
                }

                let candidates = unpaid;
                if (keyword) {
                    candidates = unpaid.filter((o) => describe(o).includes(keyword));
                    if (candidates.length === 0) {
                        return fail(
                            "NOT_FOUND",
                            `没有与“${keyword}”匹配的待支付订单。当前待支付：${unpaid.map(describe).join("；")}`,
                        );
                    }
                }
                if (candidates.length > 1) {
                    return fail(
                        "AMBIGUOUS",
                        `有 ${candidates.length} 笔待支付订单：${candidates.map(describe).join("；")}。` +
                        `请问清用户要付哪一笔，带上 keyword 重新调用。`,
                    );
                }

                const order = candidates[0];
                const resvUuid = order.orderDetails?.[0]?.resvReserveVo?.uuid;
                if (!order.uuid || !resvUuid) {
                    return fail("UPSTREAM_ERROR", "订单数据不完整（缺 uuid/预约 uuid），请到体育系统“我的预约”里支付");
                }

                // 详情复核：列表状态可能滞后，只有 TO_BE_PAID 才能发起支付
                const detail = await client.getOrderDetail(resvUuid);
                if (detail?.orderStatus !== "TO_BE_PAID") {
                    const stateMap: Record<string, string> = {
                        PAID: "已支付", CANCEL: "已取消", PAID_TIMEOUT: "已超时关闭",
                    };
                    const state = detail?.orderStatus ?? "未知";
                    return fail(
                        "NOT_AVAILABLE",
                        `这笔订单${stateMap[state] ?? `状态为 ${state}`}，不能发起支付。` +
                        `如仍需订场请重新预约。`,
                    );
                }
                const resv = detail.reservations?.[0];
                if (!resv?.siteUuid || !resv.siteType) {
                    return fail("UPSTREAM_ERROR", "订单详情缺场地标识，无法查询支付渠道");
                }

                const channels = await client.getPayChannels(resv.siteUuid, resv.siteType);
                const channelId = channels[0]?.channelId;
                if (!channelId) {
                    return fail("NOT_AVAILABLE", "该场地当前没有可用的线上支付渠道");
                }

                const launch = await client.placePayOrder(order.uuid, channelId);
                const amountYuan = typeof order.payableAmount === "number"
                    ? order.payableAmount / 100
                    : null;
                const base: PaySportsOrderData = {
                    ...(order.orderNo ? {orderNo: order.orderNo} : {}),
                    field: order.orderDetails?.[0]?.siteInfo?.siteName ?? "未知场地",
                    time: describe(order).replace(/^[^ ]* /, ""),
                    amountYuan,
                    ...(order.paymentDeadline ? {paymentDeadline: order.paymentDeadline} : {}),
                    displayMode: launch.displayMode,
                    message: "",
                };
                if (launch.displayMode === "form") {
                    return ok({
                        ...base,
                        payFormHtml: launch.displayContent,
                        message:
                            `已生成支付单${amountYuan !== null ? `（${amountYuan} 元）` : ""}。` +
                            `请在浏览器里打开支付页面，跳转到学校支付平台后用微信/支付宝完成付款` +
                            (order.paymentDeadline ? `（截止 ${order.paymentDeadline}）` : "") +
                            `。命令行环境无法展示支付页的话，也可到体育场馆预约系统的“我的预约”里支付。`,
                    });
                }
                return ok({
                    ...base,
                    payUrl: launch.displayContent,
                    message:
                        `已生成支付${launch.displayMode === "url" ? "链接" : "二维码"}` +
                        `${amountYuan !== null ? `（${amountYuan} 元）` : ""}，` +
                        `用手机扫码/打开链接付款` +
                        (order.paymentDeadline ? `（截止 ${order.paymentDeadline}）` : "") +
                        `。`,
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
