/**
 * dateContext 单测：日期/星期/教学周上下文行的生成。
 * SEMESTER_START 从环境变量即时读取，测试里直接改 env。
 */
import {afterEach, describe, expect, it} from "vitest";
import {dateContextLine} from "../../src/harness/dateContext";

const saved = process.env.SEMESTER_START;
afterEach(() => {
    if (saved === undefined) delete process.env.SEMESTER_START;
    else process.env.SEMESTER_START = saved;
});

describe("dateContextLine", () => {
    it("未配置学期时只给日期和星期", () => {
        delete process.env.SEMESTER_START;
        // 2026-09-04 是星期五
        const line = dateContextLine(new Date(2026, 8, 4));
        expect(line).toBe("今天是2026年9月4日 星期五");
    });

    it("配置学期后叠加教学周（开学当周为第 1 周）", () => {
        process.env.SEMESTER_START = "2026-08-31"; // 周一
        const line = dateContextLine(new Date(2026, 8, 4)); // 同周五 → 第 1 周
        expect(line).toBe("今天是2026年9月4日 星期五 · 秋季学期第 1 教学周");
    });

    it("学期名按开学月份推导（3 月开学 → 春季学期）", () => {
        process.env.SEMESTER_START = "2026-03-02";
        const line = dateContextLine(new Date(2026, 5, 8)); // 6 月 8 日 → 第 15 周
        expect(line).toContain("春季学期第 15 教学周");
    });

    it("开学前显示尚未开学", () => {
        process.env.SEMESTER_START = "2026-09-07";
        const line = dateContextLine(new Date(2026, 8, 4));
        expect(line).toContain("尚未开学");
        expect(line).toContain("9 月 7 日");
    });

    it("超过 20 周提示考试周或假期", () => {
        process.env.SEMESTER_START = "2026-03-02";
        const line = dateContextLine(new Date(2026, 7, 10)); // 8 月 10 日 → 第 24 周
        expect(line).toContain("第 24 教学周");
        expect(line).toContain("考试周或假期");
    });

    it("非法 SEMESTER_START 时静默降级为纯日期", () => {
        process.env.SEMESTER_START = "不是日期";
        const line = dateContextLine(new Date(2026, 8, 4));
        expect(line).toBe("今天是2026年9月4日 星期五");
    });
});
