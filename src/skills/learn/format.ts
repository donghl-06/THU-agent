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
