/**
 * Skill 层共享的日期工具。
 *
 * 约定（与 @thu-info/lib 的 parseJSON 一致）：
 *   - 星期：周一=1 …… 周日=7
 *   - 周次：从 firstDay（学期开学日，周一）起算，第 1 周、第 2 周……
 *   - "yyyy-MM-dd" 一律按本地时区解析（直接 new Date(s) 会按 UTC，差 8 小时）
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 严格解析 YYYY-MM-DD（本地时区），非法日期返回 null */
export function parseDate(s: string): Date | null {
    if (!DATE_RE.test(s)) return null;
    const [y, m, d] = s.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
        return null; // 如 2026-02-30 会被 JS 静默进位，必须拒绝
    }
    return date;
}

/** 格式化为 YYYY-MM-DD（本地时区） */
export function formatDate(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 周一=1 …… 周日=7 */
export function dayOfWeekOf(d: Date): number {
    return d.getDay() === 0 ? 7 : d.getDay();
}

/**
 * 计算 date 是第几周（firstDay 为开学日）。
 * 可能小于 1 或超出学期周数，由调用方判断。
 */
export function weekNumberOf(firstDay: Date, date: Date): number {
    return Math.floor((date.getTime() - firstDay.getTime()) / 604800000) + 1;
}
