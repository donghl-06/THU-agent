/**
 * Skill: book_library_room —— 预约图书馆研讨间（写操作，真实生效）。
 *
 * 安全红线（plan4ai.md）：requiresConfirmation = true，Harness 必须先向用户
 * 展示操作详情并拿到明确同意才会执行到这里。
 *
 * 模型只传语义参数（房间/类别关键词、日期、起止时间、成员学号），
 * Skill 内部解析成 devId 等标识符。写操作匹配必须唯一，歧义时报 AMBIGUOUS。
 *
 * 研讨间规则（来自资源字段）：时长需在 [minMinute, maxMinute] 之间、
 * 时段需在开放时段 [openStart, openEnd] 内、人数（含预约人自己）需 >= minUser。
 * 成员：预约人自动算一个；多人研讨间（minUser>1）必须用 members 传其他同学
 * 的学号——注意上游模糊搜索只认完整学号，姓名搜索不可靠（返回的是脱敏姓名），
 * 所以 members 只接受学号；用户只给了姓名就先回去问学号。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {formatDate, parseDate} from "../base/dateUtils";

export interface BookLibraryRoomData {
    roomName: string;
    kindName: string;
    date: string;
    time: string;
    members: string[];
    message: string;
}

type RoomBooker = Pick<
    ThuClient,
    "getLibraryRoomBookingInfoList" | "getLibraryRoomBookingResourceList" | "bookLibraryRoom" | "fuzzySearchLibraryId"
>;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** "HH:MM" → 当天分钟数 */
const toMin = (t: string): number => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
};

export function createBookLibraryRoomSkill(client: RoomBooker): Skill {
    return {
        name: "book_library_room",
        description:
            "预约图书馆研讨间（写操作，真实生效）。调用前必须先用 get_library_rooms 确认目标房间该时段空闲，" +
            "并向用户复述房间/日期/起止时间/成员，得到明确同意后才调用。" +
            "多人研讨间（最少人数>1）需要成员学号：members 里填同学的学号（只接受学号，" +
            "姓名搜索不可靠）；用户没提供就先问，不要编。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                keyword: {
                    type: "string",
                    description: "房间或类别关键词，如“北馆”“单人研读间”“3F-01”。必须能唯一匹配一个房间",
                },
                date: {type: "string", description: "日期 YYYY-MM-DD；省略时表示今天"},
                start: {type: "string", description: "开始时间 HH:MM，如“14:00”"},
                end: {type: "string", description: "结束时间 HH:MM，如“16:00”"},
                members: {
                    type: "array",
                    items: {type: "string"},
                    description:
                        "其他成员的学号（不含预约人自己，只接受完整学号数字）。单人研读间不用填；" +
                        "多人研讨间人数不足会预约失败",
                },
            },
            required: ["keyword", "start", "end"],
        },

        async execute(input: unknown): Promise<SkillResult<BookLibraryRoomData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.keyword !== "string" || !raw.keyword.trim()) {
                return fail("INVALID_INPUT", "keyword 必填：房间或类别关键词，如“北馆单人研读间”");
            }
            for (const k of ["start", "end"] as const) {
                if (typeof raw[k] !== "string" || !TIME_RE.test(raw[k] as string)) {
                    return fail("INVALID_INPUT", `${k} 必须是 HH:MM 格式，如“14:00”`);
                }
            }
            if (raw.date !== undefined && typeof raw.date !== "string") {
                return fail("INVALID_INPUT", "date 必须是 YYYY-MM-DD 格式的字符串");
            }
            if (raw.members !== undefined && (!Array.isArray(raw.members) || raw.members.some((m) => typeof m !== "string"))) {
                return fail("INVALID_INPUT", "members 必须是字符串数组（学号或姓名关键词）");
            }
            const target = raw.date === undefined ? new Date() : parseDate(raw.date as string);
            if (target === null) {
                return fail("INVALID_INPUT", `无法解析日期：${raw.date}，请使用 YYYY-MM-DD 格式`);
            }
            const dateStr = formatDate(target);
            const yyyymmdd = dateStr.replaceAll("-", "");
            const start = raw.start as string;
            const end = raw.end as string;
            if (toMin(end) <= toMin(start)) {
                return fail("INVALID_INPUT", "结束时间必须晚于开始时间");
            }

            try {
                // 类别 → 资源：与 get_library_rooms 同样的串行降级逻辑
                const kw = raw.keyword.trim();
                const infos = await client.getLibraryRoomBookingInfoList();
                const kinds = infos.filter((i) =>
                    i.kindName.includes(kw) || i.rooms.some((r) => r.devName.includes(kw)));
                if (kinds.length === 0) {
                    return fail("NOT_FOUND",
                        `找不到与“${kw}”匹配的研讨间类别。可选：${infos.map((i) => i.kindName).join("、")}`);
                }

                const rooms: Awaited<ReturnType<ThuClient["getLibraryRoomBookingResourceList"]>> = [];
                for (const kind of kinds) {
                    try {
                        rooms.push(...await client.getLibraryRoomBookingResourceList(yyyymmdd, kind.kindId));
                    } catch {
                        // 单个类别失败不影响其他类别（上游文图/法律馆类别经常失败）
                    }
                }
                const matched = rooms.filter((r) =>
                    r.devName.includes(kw) || r.kindName.includes(kw) || r.roomName.includes(kw));
                if (matched.length === 0) {
                    return fail("NOT_FOUND", `“${kw}”在 ${dateStr} 没有匹配的房间资源`);
                }
                if (matched.length > 1) {
                    return fail("AMBIGUOUS",
                        `“${kw}”匹配到多个房间：${matched.map((r) => `${r.kindName} ${r.devName}`).join("、")}。请用更具体的关键词。`);
                }
                const room = matched[0];

                // 规则校验：开放时段 / 时长 / 冲突 / 人数
                if (room.openStart && room.openEnd) {
                    if (toMin(start) < toMin(room.openStart) || toMin(end) > toMin(room.openEnd)) {
                        return fail("INVALID_INPUT",
                            `该房间开放时段是 ${room.openStart}-${room.openEnd}，请在这个范围内约`);
                    }
                }
                const duration = toMin(end) - toMin(start);
                if (room.minMinute > 0 && duration < room.minMinute) {
                    return fail("INVALID_INPUT", `该房间最少约 ${room.minMinute} 分钟，你约了 ${duration} 分钟`);
                }
                if (room.maxMinute > 0 && duration > room.maxMinute) {
                    return fail("INVALID_INPUT", `该房间最多约 ${room.maxMinute} 分钟，你约了 ${duration} 分钟`);
                }
                const conflict = room.usage.some((u) => {
                    const us = u.start.getHours() * 60 + u.start.getMinutes();
                    const ue = u.end.getHours() * 60 + u.end.getMinutes();
                    return us < toMin(end) && ue > toMin(start);
                });
                if (conflict) {
                    return fail("NOT_AVAILABLE",
                        `${room.devName} 在 ${dateStr} ${start}-${end} 已被占用。已订时段：` +
                        room.usage.map((u) =>
                            `${String(u.start.getHours()).padStart(2, "0")}:${String(u.start.getMinutes()).padStart(2, "0")}` +
                            `-${String(u.end.getHours()).padStart(2, "0")}:${String(u.end.getMinutes()).padStart(2, "0")}`).join("、"));
                }

                // 成员解析：人数（含自己）必须 >= minUser
                const memberInputs = (raw.members as string[] | undefined) ?? [];
                if (memberInputs.length + 1 < room.minUser) {
                    return fail("MEMBERS_REQUIRED",
                        `${room.devName} 最少需要 ${room.minUser} 人（含你自己），你目前只提供了 ${memberInputs.length} 位成员。` +
                        `请先向用户要到其他同学的学号，放到 members 里重新调用。尚未下单。`);
                }
                const memberIds: number[] = [];
                const memberLabels: string[] = [];
                for (const m of memberInputs) {
                    // 上游模糊搜索实测只认完整学号；姓名返回的是脱敏文本，无法精确匹配
                    if (!/^\d{6,}$/.test(m.trim())) {
                        return fail("INVALID_INPUT",
                            `成员“${m}”不是学号。研讨间加成员只支持完整学号（姓名搜索不可靠），请先向用户要到学号。尚未下单。`);
                    }
                    const found = await client.fuzzySearchLibraryId(m.trim());
                    if (found.length === 0) {
                        return fail("NOT_FOUND", `学号 ${m} 在研讨间系统里查不到，请和用户核对。尚未下单。`);
                    }
                    memberIds.push(found[0].id);
                    memberLabels.push(`${m.trim()}(${found[0].label})`);
                }

                await client.bookLibraryRoom(room, `${dateStr} ${start}`, `${dateStr} ${end}`, memberIds);
                return ok({
                    roomName: room.devName,
                    kindName: room.kindName,
                    date: dateStr,
                    time: `${start}-${end}`,
                    members: memberLabels,
                    message: `研讨间预约成功：${room.devName} ${dateStr} ${start}-${end}` +
                        (memberLabels.length ? `，成员：${memberLabels.join("、")}` : "") +
                        `。如需取消，提前 ${room.cancelMinute} 分钟以上。`,
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
