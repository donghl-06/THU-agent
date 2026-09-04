/**
 * 日历导出（.ics）：预约类工具成功后生成标准 VEVENT（RFC 5545），
 * webServer 以 calendar SSE 事件把现成的 ics 文本推给前端，前端只负责下载。
 *
 * 覆盖三个预约技能：
 *   book_sports_field —— {venue, field, date, time}          具体时段
 *   book_library_room —— {roomName, date, time}              具体时段
 *   book_library_seat —— {library, section, seatName, day}   无具体时段 → 全天事件
 *                                                     （座位按区域整段开放时段预约，
 *                                                       上游本就不给起止时间）
 *
 * 时间用 floating local time（无 Z 后缀、无 TZID）：按设备本地时区解释，
 * 单用户国内场景最稳，免掉 VTIMEZONE 定义。
 */
import {randomUUID} from "node:crypto";

export interface CalendarEvent {
    title: string;
    location?: string;
    /** YYYY-MM-DD */
    date: string;
    /** HH:MM；全天事件缺省 */
    start?: string;
    /** HH:MM */
    end?: string;
    allDay?: boolean;
    description?: string;
    /** 生成的 .ics 文本（可直接 Blob 下载） */
    icsContent: string;
    filename: string;
}

/** RFC 5545 文本转义：反斜杠/分号/逗号/换行 */
function icsEscape(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** YYYY-MM-DD → 20260907；带时间 → 20260907T140000（floating） */
function icsDateTime(date: string, time?: string): string {
    const compact = date.replaceAll("-", "");
    return time ? `${compact}T${time.replace(":", "")}00` : compact;
}

/** 当前时刻的 UTC DTSTAMP：20260904T120000Z */
function icsStampUtc(now: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T` +
        `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

interface EventCore {
    title: string;
    location?: string;
    date: string;
    start?: string;
    end?: string;
    allDay?: boolean;
    description?: string;
}

/** 拼装标准 VCALENDAR（CRLF 行尾；提醒提前 15 分钟） */
export function buildIcs(ev: EventCore, now = new Date()): string {
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//QingLing//THU Assistant//CN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${randomUUID()}@qingling.local`,
        `DTSTAMP:${icsStampUtc(now)}`,
        ...(ev.allDay
            ? [`DTSTART;VALUE=DATE:${icsDateTime(ev.date)}`, `DTEND;VALUE=DATE:${icsDateTime(nextDay(ev.date))}`]
            : [`DTSTART:${icsDateTime(ev.date, ev.start)}`, `DTEND:${icsDateTime(ev.date, ev.end ?? ev.start)}`]),
        `SUMMARY:${icsEscape(ev.title)}`,
        ...(ev.location ? [`LOCATION:${icsEscape(ev.location)}`] : []),
        ...(ev.description ? [`DESCRIPTION:${icsEscape(ev.description)}`] : []),
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:提醒",
        "TRIGGER:-PT15M",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
    ];
    return lines.join("\r\n") + "\r\n";
}

/** 日期 +1 天（YYYY-MM-DD，本地时区） */
function nextDay(date: string): string {
    const [y, m, d] = date.split("-").map(Number);
    const next = new Date(y, m - 1, d + 1);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`;
}

/** 解析 "HH:MM-HH:MM" → {start, end}；格式不符返回 undefined */
function splitRange(time: string): {start: string; end: string} | undefined {
    const m = /^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(time.trim());
    if (!m) return undefined;
    return {start: m[1], end: m[2]};
}

/** 预约类工具结果 → 日历事件；非预约工具/失败结果/格式不符返回 undefined */
export function extractCalendarEvent(toolName: string, toolResultJson: string): CalendarEvent | undefined {
    let d: Record<string, unknown>;
    try {
        const parsed = JSON.parse(toolResultJson) as {success?: boolean; data?: Record<string, unknown>};
        if (!parsed.success || !parsed.data || typeof parsed.data !== "object") return undefined;
        d = parsed.data;
    } catch {
        return undefined;
    }
    const message = typeof d.message === "string" ? d.message : undefined;

    let core: EventCore | undefined;
    switch (toolName) {
        case "book_sports_field": {
            if (typeof d.date !== "string" || typeof d.time !== "string") return undefined;
            const range = splitRange(d.time);
            if (!range) return undefined;
            const field = typeof d.field === "string" ? d.field : "";
            const venue = typeof d.venue === "string" ? d.venue : "体育场馆";
            const pendingPay = d.orderGenerated === true && d.freeOrder === false;
            core = {
                title: field ? `${venue}（${field}）` : venue,
                location: venue,
                date: d.date,
                ...range,
                description: (pendingPay ? "【待支付】请尽快完成线上支付，超时订单会自动取消。\n" : "") + (message ?? ""),
            };
            break;
        }
        case "book_library_room": {
            if (typeof d.date !== "string" || typeof d.time !== "string") return undefined;
            const range = splitRange(d.time);
            if (!range) return undefined;
            const roomName = typeof d.roomName === "string" ? d.roomName : "研讨间";
            core = {
                title: `研讨间 · ${roomName}`,
                location: roomName,
                date: d.date,
                ...range,
                description: message ?? "",
            };
            break;
        }
        case "book_library_seat": {
            if (typeof d.day !== "string") return undefined;
            const library = typeof d.library === "string" ? d.library : "图书馆";
            const section = typeof d.section === "string" ? d.section : "";
            const seatName = typeof d.seatName === "string" ? d.seatName : "";
            // 座位按区域整段开放时段预约，上游无起止时间 → 全天事件 + 签到提醒写进描述
            const dayText = d.day === "today" ? "今天" : d.day === "tomorrow" ? "明天" : d.day;
            core = {
                title: `图书馆座位 · ${library}${section ? ` ${section}` : ""}${seatName ? ` ${seatName}` : ""}`,
                location: section ? `${library} ${section}` : library,
                date: localDateOfDay(d.day),
                allDay: true,
                description: `座位日：${dayText}。${message ?? "请按时到馆签到，迟到可能被记违约。"}`,
            };
            break;
        }
        default:
            return undefined;
    }
    return {
        ...core,
        icsContent: buildIcs(core),
        filename: `清灵-${core.title.replace(/[\\/:*?"<>|\s]+/g, "-")}.ics`,
    };
}

/** today/tomorrow → 本地日期 YYYY-MM-DD */
function localDateOfDay(day: string): string {
    const target = day === "tomorrow" ? 1 : 0;
    const d = new Date();
    d.setDate(d.getDate() + target);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
