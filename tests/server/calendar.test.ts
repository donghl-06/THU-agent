/**
 * 日历导出单测：三类预约工具结果的事件提取 + .ics 文本生成（RFC 5545 细节）。
 */
import {describe, expect, it} from "vitest";
import {buildIcs, extractCalendarEvent} from "../../src/server/calendar";

const okResult = (data: Record<string, unknown>) => JSON.stringify({success: true, data});

describe("extractCalendarEvent", () => {
    it("book_sports_field：提取时段事件，待支付写进描述", () => {
        const ev = extractCalendarEvent("book_sports_field", okResult({
            venue: "气膜馆羽毛球", field: "羽03",
            date: "2026-09-06", time: "06:00-07:30",
            orderGenerated: true, freeOrder: false,
            message: "已下单，生成了待支付订单（20 元）。",
        }))!;
        expect(ev.title).toBe("气膜馆羽毛球（羽03）");
        expect(ev.location).toBe("气膜馆羽毛球");
        expect(ev.date).toBe("2026-09-06");
        expect(ev.start).toBe("06:00");
        expect(ev.end).toBe("07:30");
        expect(ev.allDay).toBeFalsy();
        expect(ev.description).toContain("待支付");
        expect(ev.icsContent).toContain("BEGIN:VCALENDAR");
    });

    it("book_library_room：提取研讨间事件", () => {
        const ev = extractCalendarEvent("book_library_room", okResult({
            roomName: "文图书馆202", kindName: "研讨间",
            date: "2026-09-07", time: "14:00-16:00",
            members: [], message: "研讨间预约成功。",
        }))!;
        expect(ev.title).toBe("研讨间 · 文图书馆202");
        expect(ev.start).toBe("14:00");
        expect(ev.end).toBe("16:00");
    });

    it("book_library_seat：无时段 → 全天事件，today/tomorrow 转本地日期", () => {
        const ev = extractCalendarEvent("book_library_seat", okResult({
            library: "北馆(李文正馆)", section: "3F-A区", seatName: "001",
            day: "tomorrow", message: "预约成功。",
        }))!;
        expect(ev.allDay).toBe(true);
        expect(ev.title).toContain("北馆(李文正馆)");
        const expected = new Date();
        expected.setDate(expected.getDate() + 1);
        const p = (n: number) => String(n).padStart(2, "0");
        expect(ev.date).toBe(`${expected.getFullYear()}-${p(expected.getMonth() + 1)}-${p(expected.getDate())}`);
    });

    it("失败结果/未知工具/非法 JSON/时段格式异常 → undefined", () => {
        const failResult = JSON.stringify({success: false, error: {code: "X", message: "y"}});
        expect(extractCalendarEvent("book_sports_field", failResult)).toBeUndefined();
        expect(extractCalendarEvent("get_schedule", okResult({date: "2026-09-06", time: "06:00-07:00"}))).toBeUndefined();
        expect(extractCalendarEvent("book_sports_field", "not json")).toBeUndefined();
        expect(extractCalendarEvent("book_sports_field", okResult({
            venue: "x", field: "y", date: "2026-09-06", time: "半夜",
        }))).toBeUndefined();
    });
});

describe("buildIcs", () => {
    const sample = buildIcs({
        title: "研讨间, 文图书馆; 202",
        location: "文图书馆",
        date: "2026-09-07",
        start: "14:00",
        end: "16:00",
        description: "成员：张三\n如需取消请提前。",
    }, new Date(2026, 8, 4, 12, 0, 0));

    it("基本结构与 CRLF 行尾", () => {
        expect(sample.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
        expect(sample.endsWith("END:VCALENDAR\r\n")).toBe(true);
        expect(sample).toContain("PRODID:-//QingLing//THU Assistant//CN");
        expect(sample).toContain("BEGIN:VEVENT");
        expect(sample).toContain("END:VEVENT");
    });

    it("floating 本地时间 + UTC DTSTAMP", () => {
        expect(sample).toContain("DTSTART:20260907T140000\r\n");
        expect(sample).toContain("DTEND:20260907T160000\r\n");
        expect(sample).toContain("DTSTAMP:20260904T040000Z\r\n"); // 本地 12:00 → UTC 04:00
        expect(sample).toMatch(/UID:\S+@qingling\.local/);
    });

    it("文本转义：逗号/分号/换行", () => {
        expect(sample).toContain("SUMMARY:研讨间\\, 文图书馆\\; 202");
        expect(sample).toContain("DESCRIPTION:成员：张三\\n如需取消请提前。");
    });

    it("内置提前 15 分钟提醒", () => {
        expect(sample).toContain("BEGIN:VALARM");
        expect(sample).toContain("TRIGGER:-PT15M");
    });

    it("全天事件：VALUE=DATE 且 DTEND 为次日", () => {
        const allDay = buildIcs({title: "座位", date: "2026-09-07", allDay: true});
        expect(allDay).toContain("DTSTART;VALUE=DATE:20260907\r\n");
        expect(allDay).toContain("DTEND;VALUE=DATE:20260908\r\n");
        expect(allDay).not.toContain("T140000");
    });
});
