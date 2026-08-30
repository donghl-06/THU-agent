/**
 * Step 19 全链路探测（一次性，用户已批准 2026-08-30）：
 *   订一个最近的线上支付场次（真实占场）→ 生成支付二维码（不动钱）→ 立即取消订单。
 *
 * 目的：真实验证 listMyOrders / getOrderDetail / getPayChannels / placePayOrder /
 * cancelOrder 五个方法的请求与响应形状。全程不扫码不付款，资金零移动。
 *
 * 运行：OPENSSL_CONF=$PWD/openssl.cnf npx tsx scripts/probe-sports-pay.ts
 */
import {SportsClient} from "../src/client/sports/SportsClient";
import {createChaojiyingSolver} from "../src/client/captcha/chaojiying";
import {formatDate} from "../src/skills/base/dateUtils";

const client = new SportsClient();

// ---- 1. 挑一个可约的线上支付场次（今天优先，其次明天；气膜馆羽毛球是此前实测场景） ----
const scenes = await client.listScenes();
const scene = scenes.find((s) => s.sceneName.includes("气膜馆") && s.sceneName.includes("羽毛球"));
if (!scene) throw new Error("找不到气膜馆羽毛球场景：" + scenes.map((s) => s.sceneName).join("、"));
console.log("场景：", scene.sceneName);

let picked: {date: string; fieldName: string; fieldUuid: string; siteType: string; formUuid: string;
    sessionUuid: string; start: string; end: string; feeYuan: number | null} | undefined;
for (const offset of [0, 1]) {
    const date = formatDate(new Date(Date.now() + offset * 86400_000));
    const fields = await client.getFieldPage(scene.uuid, date);
    for (const f of fields) {
        for (const s of f.sessions) {
            // 今天的场次必须是未来时段；费用已知且 >0 才好验证金额展示
            if (!s.available) continue;
            if (offset === 0) {
                const now = new Date();
                const [h, m] = s.start.split(":").map(Number);
                if (h * 60 + m <= now.getHours() * 60 + now.getMinutes() + 30) continue;
            }
            picked = {date, fieldName: f.siteName, fieldUuid: f.uuid, siteType: f.siteType,
                formUuid: f.formUuid, sessionUuid: s.uuid, start: s.start, end: s.end, feeYuan: s.feeYuan};
            break;
        }
        if (picked) break;
    }
    if (picked) break;
}
if (!picked) throw new Error("今明两天没有找到可约场次");
console.log(`选定：${picked.date} ${picked.start}-${picked.end} ${picked.fieldName}（${picked.feeYuan ?? "?"} 元）`);

// ---- 2. 下单（线上支付） ----
let captcha: string | undefined;
if (await client.isCaptchaEnabled()) {
    console.log("滑块验证码已开启，走打码平台…");
    const solver = createChaojiyingSolver();
    const cap = await client.getDragCaptcha();
    const x = await solver({
        backgroundBase64: cap.backgroundBase64,
        jigsawBase64: cap.jigsawBase64,
        tryX: (candidate) => client.checkDragCaptcha(cap, candidate),
    });
    captcha = client.buildCaptchaValue(cap, x);
    console.log("验证码通过。");
}
const booked = await client.bookSession({
    sceneUuid: scene.uuid,
    sceneUseType: "SPORT_GROUP",
    siteUuid: picked.fieldUuid,
    siteType: picked.siteType,
    formUuid: picked.formUuid,
    sessionUuid: picked.sessionUuid,
    date: picked.date,
    startTime: picked.start,
    endTime: picked.end,
    payType: "PAY_ONLINE",
    ...(captcha ? {captcha} : {}),
});
console.log("下单结果：", booked);
if (!booked.orderGenerated) throw new Error("未生成订单，无法继续探测支付");

// ---- 3. 在订单列表里找到它 ----
const orders = await client.listMyOrders(10);
const mine = orders.find((o) => {
    const details = (o as {orderDetails?: {resvReserveVo?: {uuid?: string}}[]}).orderDetails ?? [];
    return details.some((d) => d.resvReserveVo?.uuid && booked.resvIds.includes(d.resvReserveVo.uuid));
});
if (!mine?.uuid) throw new Error("订单列表里没找到刚下的单");
console.log(`找到订单：uuid=${mine.uuid.slice(0, 8)}… status=${mine.orderStatus} payType=${mine.payType} 应付=${(mine.payableAmount ?? 0) / 100} 元`);

// ---- 4. 订单详情（用预约 uuid） ----
const detail = await client.getOrderDetail(booked.resvIds[0]);
const d = detail as Record<string, unknown> & {reservations?: {siteUuid?: string; siteType?: string}[]};
console.log("详情：orderStatus=", d?.orderStatus, " payType=", d?.payType, " payableAmount=", d?.payableAmount);
const r = d?.reservations?.[0];
if (!r?.siteUuid || !r.siteType) throw new Error("详情缺 reservations[0].siteUuid/siteType");

// ---- 5. 支付渠道 ----
const channels = await client.getPayChannels(r.siteUuid, r.siteType);
console.log("渠道：", channels.map((c) => `${c.name}(${c.channelId})`).join("、"));
const channelId = channels[0]?.channelId;
if (!channelId) throw new Error("无可用支付渠道");

// ---- 6. 发起支付：只生成支付参数，不付款 ----
const launch = await client.placePayOrder(mine.uuid, channelId);
console.log("displayMode:", launch.displayMode);
console.log("displayContent 前 150 字符：", launch.displayContent.slice(0, 150));

// ---- 7. 立即取消订单，释放场地 ----
await client.cancelOrder(mine.uuid);
const after = await client.getOrderDetail(booked.resvIds[0]);
console.log("取消后订单状态：", (after as {orderStatus?: string})?.orderStatus);
console.log("\n探测完成：未扫码、未付款，场地已释放。");
