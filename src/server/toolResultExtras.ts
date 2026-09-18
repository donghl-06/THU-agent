/**
 * 工具结果附加产物提取：支付链接 → 二维码 data URL、自动提交支付表单 HTML。
 * 对话路径（webServer）与定时任务执行记录（scheduledRun）共用，
 * 保证后台任务生成的付款码同样能以二维码图片呈现。
 */

/** 把支付链接转成二维码 data URL（qrcode 为可选依赖：装了就发图，没装前端只显示链接） */
export async function makeQrDataUrl(url: string): Promise<string | undefined> {
    try {
        const qrcode = await import("qrcode");
        return await qrcode.toDataURL(url, {width: 320, margin: 1});
    } catch {
        return undefined;
    }
}

/** 从工具结果 JSON 里找支付链接（电费等充值技能会返回 payUrl） */
export function extractPayUrl(toolResultJson: string): string | undefined {
    try {
        const parsed = JSON.parse(toolResultJson) as {success?: boolean; data?: {payUrl?: string}};
        if (parsed.success && typeof parsed.data?.payUrl === "string") return parsed.data.payUrl;
    } catch { /* 不是 JSON 或没有 payUrl */ }
    return undefined;
}

/** 从工具结果 JSON 里找自动提交的支付表单 HTML（体育订单 form 模式） */
export function extractPayFormHtml(toolResultJson: string): string | undefined {
    try {
        const parsed = JSON.parse(toolResultJson) as {success?: boolean; data?: {payFormHtml?: string}};
        if (parsed.success && typeof parsed.data?.payFormHtml === "string") return parsed.data.payFormHtml;
    } catch { /* 同上 */ }
    return undefined;
}
