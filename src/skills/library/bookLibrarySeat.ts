/**
 * Skill: book_library_seat —— 预约图书馆座位（写操作，真实生效）。
 *
 * 安全红线（plan4ai.md）：requiresConfirmation = true，Harness 必须先向用户
 * 展示操作详情并拿到明确同意才会执行到这里。
 *
 * 模型只传语义参数（馆/区域/座位号关键词），Skill 内部走 馆→楼层→区域→座位
 * 四级解析。写操作匹配必须唯一：匹配到多个座位时报 AMBIGUOUS 让模型回去问，
 * 绝不能随便挑一个订。
 *
 * 注意：座位系统只能约今天或明天（dateChoice 0/1），且按馆区整段开放时段约，
 * 不能自选起止时间（约到后按区域开放时段入座）。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface BookLibrarySeatData {
    library: string;
    section: string;
    seatName: string;
    day: string;
    /** 给用户看的下一步提示 */
    message: string;
}

type SeatBooker = Pick<
    ThuClient,
    "getLibraryList" | "getLibraryFloorList" | "getLibrarySectionList" | "getLibrarySeatList" | "bookLibrarySeat"
>;

export function createBookLibrarySeatSkill(client: SeatBooker): Skill {
    return {
        name: "book_library_seat",
        description:
            "预约图书馆座位（写操作，真实生效）。只能约今天或明天。" +
            "调用前必须先用 get_library_seats 确认目标区域有空位，并向用户复述馆/区域/座位/日期，" +
            "得到明确同意后才调用。seatName 省略时自动选该区域的第一个空位（需在确认时告知用户）。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                day: {
                    type: "string",
                    enum: ["today", "tomorrow"],
                    description: "约今天还是明天，默认 today",
                },
                library: {
                    type: "string",
                    description: "馆名关键词，如“北馆”“西馆”“文科”。必须能唯一匹配一个馆",
                },
                section: {
                    type: "string",
                    description: "区域名关键词，如“三层”“B区”。可选，用于缩小座位范围",
                },
                seatName: {
                    type: "string",
                    description: "座位号，如“A001”。可选，省略时自动选该区域第一个空位",
                },
            },
            required: ["library"],
        },

        async execute(input: unknown): Promise<SkillResult<BookLibrarySeatData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (raw.day !== undefined && raw.day !== "today" && raw.day !== "tomorrow") {
                return fail("INVALID_INPUT", "day 只能是 \"today\" 或 \"tomorrow\"");
            }
            if (typeof raw.library !== "string" || !raw.library.trim()) {
                return fail("INVALID_INPUT", "library 必填：馆名关键词，如“北馆”");
            }
            for (const k of ["section", "seatName"] as const) {
                if (raw[k] !== undefined && typeof raw[k] !== "string") {
                    return fail("INVALID_INPUT", `${k} 必须是字符串`);
                }
            }
            const day = (raw.day as "today" | "tomorrow" | undefined) ?? "today";
            const dateChoice: 0 | 1 = day === "today" ? 0 : 1;

            try {
                // 第一级：馆（写操作必须唯一匹配）
                const libKw = raw.library.trim();
                const libs = (await client.getLibraryList())
                    .filter((l) => l.valid && l.zhName.includes(libKw));
                if (libs.length === 0) return fail("NOT_FOUND", `找不到名称包含“${libKw}”的图书馆`);
                if (libs.length > 1) {
                    return fail("AMBIGUOUS", `“${libKw}”匹配到多个馆：${libs.map((l) => l.zhName).join("、")}。请用更具体的关键词。`);
                }

                // 第二、三级：楼层 → 区域（可按 section 关键词过滤）
                const floors = (await client.getLibraryFloorList(libs[0], dateChoice)).filter((f) => f.valid);
                let sections = (await Promise.all(
                    floors.map((f) => client.getLibrarySectionList(f, dateChoice)),
                )).flat().filter((s) => s.valid);
                if (typeof raw.section === "string" && raw.section.trim()) {
                    const secKw = raw.section.trim();
                    sections = sections.filter((s) => s.zhName.includes(secKw) || s.zhNameTrace.includes(secKw));
                    if (sections.length === 0) return fail("NOT_FOUND", `${libs[0].zhName} 里找不到名称含“${secKw}”的区域`);
                }
                sections = sections.filter((s) => s.available > 0);
                if (sections.length === 0) {
                    return fail("NOT_AVAILABLE", `${libs[0].zhName} ${day === "today" ? "今天" : "明天"}没有空位区域`);
                }

                // 第四级：座位。逐区域拉座位明细，只在 status === "available" 里选
                const availableSeats: {seat: Awaited<ReturnType<ThuClient["getLibrarySeatList"]>>[number];
                    section: (typeof sections)[number]}[] = [];
                for (const section of sections) {
                    const seats = await client.getLibrarySeatList(section, dateChoice);
                    for (const seat of seats) {
                        if (seat.status === "available") availableSeats.push({seat, section});
                    }
                }
                if (availableSeats.length === 0) {
                    return fail("NOT_AVAILABLE", `${libs[0].zhName} 目标区域当前没有可约座位（可能刚被约走，可重新查询）`);
                }

                let chosen = availableSeats[0];
                if (typeof raw.seatName === "string" && raw.seatName.trim()) {
                    const seatKw = raw.seatName.trim();
                    const named = availableSeats.filter((s) => s.seat.zhName.includes(seatKw));
                    if (named.length === 0) {
                        return fail("NOT_AVAILABLE", `座位“${seatKw}”当前不可约。可约：${availableSeats.slice(0, 5).map((s) => s.seat.zhName).join("、")} 等`);
                    }
                    if (named.length > 1) {
                        return fail("AMBIGUOUS", `“${seatKw}”匹配到多个可约座位：${named.map((s) => s.seat.zhName).join("、")}。请说完整座位号。`);
                    }
                    chosen = named[0];
                }

                const resp = await client.bookLibrarySeat(chosen.seat, chosen.section, dateChoice);
                // 上游约定：status===1 才是成功（0 是失败，msg 带原因）——thu-info-app 官方 UI 这么判
                if (resp.status !== 1) {
                    return fail("UPSTREAM_ERROR", `预约失败：${resp.msg || "学校系统未给出原因"}`);
                }
                return ok({
                    library: libs[0].zhName,
                    section: chosen.section.zhName,
                    seatName: chosen.seat.zhName,
                    day,
                    message: `预约成功：${libs[0].zhName} ${chosen.section.zhName} ${chosen.seat.zhName}（${day === "today" ? "今天" : "明天"}）。记得按时到馆签到，迟到可能被记违约。`,
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
