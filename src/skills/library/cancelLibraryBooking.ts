/**
 * Skill: cancel_library_booking —— 取消我的图书馆预约（座位或研讨间，写操作，真实生效）。
 *
 * 安全红线（plan4ai.md）：requiresConfirmation = true，Harness 必须先向用户
 * 展示操作详情并拿到明确同意才会执行到这里。
 *
 * 模型只传语义参数（日期/位置或房间关键词），Skill 内部先拉"我的预约"记录再匹配。
 * 写操作匹配必须唯一：匹配多条时报 AMBIGUOUS 并列出候选，让模型回去问用户，
 * 绝不能随便取消一条。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface CancelLibraryBookingData {
    kind: "seat" | "room";
    description: string;
    message: string;
}

type CancelSource = Pick<
    ThuClient,
    "getBookingRecords" | "cancelBooking" | "getLibraryRoomBookingRecord" | "cancelLibraryRoomBooking"
>;

const hhmm = (d: Date): string =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function createCancelLibraryBookingSkill(client: CancelSource): Skill {
    return {
        name: "cancel_library_booking",
        description:
            "取消我的图书馆预约（座位或研讨间，写操作，真实生效）。调用前必须先用 get_my_library_bookings " +
            "确认有哪条记录，并向用户复述要取消的记录，得到明确同意后才调用。" +
            "用 date/keyword 定位记录；匹配到多条时会返回候选列表，这时要回去问用户具体是哪条。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    enum: ["seat", "room"],
                    description: "取消座位预约还是研讨间预约；不确定就省略，两类都会匹配",
                },
                date: {
                    type: "string",
                    description: "预约所在日期 YYYY-MM-DD，用于过滤记录；省略时匹配全部日期的记录",
                },
                keyword: {
                    type: "string",
                    description: "位置/房间关键词，如“A001”“研读间”；用于在记录里定位",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<CancelLibraryBookingData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (raw.kind !== undefined && raw.kind !== "seat" && raw.kind !== "room") {
                return fail("INVALID_INPUT", "kind 只能是 \"seat\" 或 \"room\"");
            }
            for (const k of ["date", "keyword"] as const) {
                if (raw[k] !== undefined && typeof raw[k] !== "string") {
                    return fail("INVALID_INPUT", `${k} 必须是字符串`);
                }
            }
            const dateKw = typeof raw.date === "string" ? raw.date.trim() : "";
            if (dateKw && !/^\d{4}-\d{2}-\d{2}$/.test(dateKw)) {
                return fail("INVALID_INPUT", "date 必须是 YYYY-MM-DD 格式");
            }
            const kw = typeof raw.keyword === "string" ? raw.keyword.trim() : "";

            try {
                // 候选：{kind, id(取消用), label(给用户看)}
                const candidates: {kind: "seat" | "room"; id: string; label: string}[] = [];

                if (raw.kind !== "room") {
                    for (const r of await client.getBookingRecords()) {
                        if (r.delId === undefined) continue; // 没有取消入口的记录（已过期/已签到等）
                        const label = `座位 ${r.pos} ${r.time}（${r.status}）`;
                        if (dateKw && !r.time.includes(dateKw)) continue;
                        if (kw && !r.pos.includes(kw)) continue;
                        candidates.push({kind: "seat", id: r.delId, label});
                    }
                }
                if (raw.kind !== "seat") {
                    // 上游 resvDate 可能是 yyyyMMdd（无连字符），统一剥掉分隔符再比
                    const dateDigits = dateKw.replaceAll("-", "");
                    for (const r of await client.getLibraryRoomBookingRecord()) {
                        const label = `研讨间 ${r.devName} ${r.date} ${hhmm(r.begin)}-${hhmm(r.end)}`;
                        if (dateKw && !r.date.replaceAll("-", "").includes(dateDigits)) continue;
                        if (kw && !r.devName.includes(kw) && !r.kindName.includes(kw)) continue;
                        candidates.push({kind: "room", id: r.uuid, label});
                    }
                }

                if (candidates.length === 0) {
                    return fail("NOT_FOUND",
                        "没有找到可取消的预约记录" + (dateKw || kw ? `（过滤条件：${[dateKw, kw].filter(Boolean).join(" / ")}）` : "") +
                        "。可以先用 get_my_library_bookings 查看当前记录。未取消任何记录。");
                }
                if (candidates.length > 1) {
                    return fail("AMBIGUOUS",
                        `匹配到 ${candidates.length} 条可取消的记录：${candidates.map((c) => c.label).join("；")}。` +
                        `请向用户确认是哪一条（补充 kind/date/keyword 后重新调用）。未取消任何记录。`);
                }

                const target = candidates[0];
                if (target.kind === "seat") {
                    await client.cancelBooking(target.id);
                } else {
                    await client.cancelLibraryRoomBooking(target.id);
                }
                return ok({
                    kind: target.kind,
                    description: target.label,
                    message: `已取消：${target.label}`,
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
