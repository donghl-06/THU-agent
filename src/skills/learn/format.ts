/**
 * 网络学堂技能共享的时间格式化：统一输出北京时间 "2026-09-13 14:30"。
 * （容器/桌面可能在任意时区，学堂时间一律按 Asia/Shanghai 给用户看）
 */
export function formatBeijing(date: Date): string {
    const parts = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** 北京时间的 YYYY-MM-DD 日期串。offsetDays 用于「N 天后」（可为负） */
export function beijingDateString(offsetDays = 0, base = new Date()): string {
    const shifted = new Date(base.getTime() + offsetDays * 24 * 3600 * 1000);
    const parts = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(shifted);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
}
