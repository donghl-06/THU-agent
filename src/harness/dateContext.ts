/**
 * 系统提示词的日期/校历上下文。
 *
 * 模型对"今天星期几""第几教学周"的自算不可靠（尤其教学周），课表类问题
 * 又强依赖这两项——直接把权威信息算好喂给它，模型不用猜。
 *
 * SEMESTER_START（学期第一教学周的周一，YYYY-MM-DD）配置了才叠加教学周；
 * 学期名从配置的开学月份推导（如 9 月开学 → 整个学期都叫秋季学期）。
 */
import {config} from "../config/env";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

function semesterName(startMonth: number): string {
    // 8 月底开学即秋季学期开始；1 月仍属上学期期末
    if (startMonth >= 8 || startMonth === 1) return "秋季学期";
    return "春季学期";
}

export function dateContextLine(now = new Date()): string {
    const y = now.getFullYear();
    const month = now.getMonth() + 1;
    const d = now.getDate();
    const weekday = WEEKDAYS[now.getDay()];
    let line = `今天是${y}年${month}月${d}日 星期${weekday}`;

    const start = config.calendar.semesterStart;
    if (start) {
        const parsed = new Date(`${start}T00:00:00`);
        if (!Number.isNaN(parsed.getTime())) {
            const startDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
            const today = new Date(y, now.getMonth(), d);
            const week = Math.floor((today.getTime() - startDay.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
            if (week < 1) {
                line += `（${startDay.getMonth() + 1} 月 ${startDay.getDate()} 日开学，现在尚未开学）`;
            } else {
                line += ` · ${semesterName(startDay.getMonth() + 1)}第 ${week} 教学周`;
                if (week > 20) line += "（可能处于考试周或假期）";
            }
        }
    }
    return line;
}
