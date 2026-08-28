/**
 * Skill: get_classroom_state —— 查询某教学楼某天有哪些教室空闲。
 *
 * 库的接口是按"教学楼 + 周次"返回全周 42 格状态（7 天 × 6 时段），
 * 本 Skill 负责：教学楼名模糊匹配 → 日期换算周次 → 只保留当天有空闲时段的教室。
 *
 * 时段编号 1-6 对应教室状态页每天的六个时段（从上午到晚上）。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {dayOfWeekOf, formatDate, parseDate, weekNumberOf} from "../base/dateUtils";
import {ClassroomStatus} from "@thu-info/lib/dist/models/home/classroom";

export interface ClassroomRoomState {
    /** 教室名（如 "6A214"） */
    name: string;
    /** 当天空闲的时段编号（1-6） */
    availableBlocks: number[];
}

export interface ClassroomStateData {
    /** 匹配到的教学楼名 */
    building: string;
    date: string;
    dayOfWeek: number;
    weekNumber: number | null;
    /** 当天有空闲时段的教室 */
    rooms: ClassroomRoomState[];
    totalRooms: number;
    note?: string;
}

type ClassroomSource = Pick<ThuClient, "getCalendar" | "getClassroomList" | "getClassroomState">;

export function createGetClassroomStateSkill(client: ClassroomSource): Skill {
    return {
        name: "get_classroom_state",
        description:
            "查询指定教学楼在指定日期（默认今天）的空闲教室。" +
            "教学楼名支持模糊输入（如“六教”“三教”），返回当天有空闲时段的教室及其空闲时段编号。",
        inputSchema: {
            type: "object",
            properties: {
                building: {
                    type: "string",
                    description: "教学楼名称，如“六教”“新水利馆”",
                },
                date: {
                    type: "string",
                    description: "要查询的日期，格式 YYYY-MM-DD；省略时表示今天",
                },
            },
            required: ["building"],
        },

        async execute(input: unknown): Promise<SkillResult<ClassroomStateData>> {
            // 1. 校验输入
            const raw = (input ?? {}) as {building?: unknown; date?: unknown};
            if (typeof raw.building !== "string" || raw.building.trim() === "") {
                return fail("INVALID_INPUT", "building 必填，如“六教”");
            }
            if (raw.date !== undefined && typeof raw.date !== "string") {
                return fail("INVALID_INPUT", "date 必须是 YYYY-MM-DD 格式的字符串");
            }
            const target = raw.date === undefined ? new Date() : parseDate(raw.date as string);
            if (target === null) {
                return fail("INVALID_INPUT", `无法解析日期：${raw.date}，请使用 YYYY-MM-DD 格式`);
            }

            try {
                // 2. 教学楼名模糊匹配（教室列表同时给出当前周次）
                const list = await client.getClassroomList();
                const building = raw.building.trim();
                const matched = list.find((c) => c.name.includes(building))
                    ?? list.find((c) => building.includes(c.name));
                if (!matched) {
                    return fail(
                        "INVALID_INPUT",
                        `找不到教学楼“${building}”。可选：${list.map((c) => c.name).join("、")}`,
                    );
                }

                // 3. 日期 → 学期周次
                const calendar = await client.getCalendar();
                const firstDay = parseDate(calendar.firstDay);
                if (firstDay === null) {
                    return fail("UPSTREAM_ERROR", `无法解析学期开学日期：${calendar.firstDay}`);
                }
                const weekNumber = weekNumberOf(firstDay, target);
                const base: ClassroomStateData = {
                    building: matched.name,
                    date: formatDate(target),
                    dayOfWeek: dayOfWeekOf(target),
                    weekNumber: null,
                    rooms: [],
                    totalRooms: 0,
                };
                if (weekNumber < 1 || weekNumber > calendar.weekCount) {
                    return ok({
                        ...base,
                        note: `${formatDate(target)} 不在 ${calendar.semesterName} 范围内，无法查询`,
                    });
                }

                // 4. 拉全周状态，过滤当天有空闲时段的教室
                const state = await client.getClassroomState(matched.searchName, weekNumber);
                const dayIndex = dayOfWeekOf(target) - 1; // 42 格从周一开始
                const rooms: ClassroomRoomState[] = state.classroomStates
                    .map((room) => ({
                        name: room.name.split(":")[0].trim(),
                        availableBlocks: room.status
                            .slice(dayIndex * 6, dayIndex * 6 + 6)
                            .map((s, i) => (s === ClassroomStatus.AVAILABLE ? i + 1 : 0))
                            .filter((b) => b > 0),
                    }))
                    .filter((room) => room.availableBlocks.length > 0);

                return ok({
                    ...base,
                    weekNumber,
                    rooms,
                    totalRooms: state.classroomStates.length,
                });
            } catch (e) {
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
