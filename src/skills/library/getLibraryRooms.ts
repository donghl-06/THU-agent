/**
 * Skill: get_library_rooms —— 查询图书馆研讨间的房间与占用情况。
 *
 * 两步：先拿研讨间类别清单（kindId），再按天查每类下的房间资源和占用段。
 * 输出每间房的开放窗口、人数/时长限制和已订时段，模型据此回答空闲情况。
 * （预约/取消是写操作，在 Step 16 单独的 skill 里做。）
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {formatDate, parseDate} from "../base/dateUtils";

export interface LibraryRoomData {
    date: string;
    rooms: {
        kindName: string;
        roomName: string;
        devName: string;
        /** 最少/最多使用人数 */
        minUser: number;
        maxUser: number;
        /** 单次最短/最长预约分钟数 */
        minMinute: number;
        maxMinute: number;
        /** 开放窗口，如 "08:00"-"22:00"，可能为空 */
        openStart: string | null;
        openEnd: string | null;
        /** 当天已被订走的时段 */
        booked: {start: string; end: string}[];
    }[];
    /** 查询失败的类别（部分馆别的接口会报"操作失败"，实测北馆正常、文图/法律馆等失败） */
    failedKinds: string[];
}

type LibraryRoomSource = Pick<ThuClient, "getLibraryRoomBookingInfoList" | "getLibraryRoomBookingResourceList">;

const hhmm = (d: Date): string =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function createGetLibraryRoomsSkill(client: LibraryRoomSource): Skill {
    return {
        name: "get_library_rooms",
        description:
            "查询图书馆研讨间（讨论间）某天的房间清单、开放时间和已订时段。" +
            "可用 keyword 按房间名/类别名过滤（如“文图”“经管”）。",
        inputSchema: {
            type: "object",
            properties: {
                date: {type: "string", description: "日期 YYYY-MM-DD；省略时表示今天"},
                keyword: {type: "string", description: "可选，房间名/类别名关键词过滤"},
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<LibraryRoomData>> {
            const raw = (input ?? {}) as {date?: unknown; keyword?: unknown};
            if (raw.date !== undefined && typeof raw.date !== "string") {
                return fail("INVALID_INPUT", "date 必须是 YYYY-MM-DD 格式的字符串");
            }
            if (raw.keyword !== undefined && typeof raw.keyword !== "string") {
                return fail("INVALID_INPUT", "keyword 必须是字符串");
            }
            const target = raw.date === undefined ? new Date() : parseDate(raw.date as string);
            if (target === null) {
                return fail("INVALID_INPUT", `无法解析日期：${raw.date}，请使用 YYYY-MM-DD 格式`);
            }
            const dateStr = formatDate(target);
            const yyyymmdd = dateStr.replaceAll("-", "");
            const keyword = typeof raw.keyword === "string" ? raw.keyword.trim() : "";

            try {
                const infos = await client.getLibraryRoomBookingInfoList();
                // 类别层面先做关键词过滤，减少无谓的资源查询
                const kinds = keyword
                    ? infos.filter((k) => k.kindName.includes(keyword) || k.rooms.some((r) => r.devName.includes(keyword)))
                    : infos;
                if (kinds.length === 0) {
                    return fail(
                        "NOT_FOUND",
                        `没有与“${keyword}”匹配的研讨间类别。可选：${infos.map((k) => k.kindName).join("、")}`,
                    );
                }
                // 逐类别串行查询，单类失败降级进 failedKinds（体育场景同款策略：
                // 部分馆别接口实测持续报"操作失败"，不能拖垮整次查询）
                const rooms: LibraryRoomData["rooms"] = [];
                const failedKinds: string[] = [];
                for (const k of kinds) {
                    try {
                        const list = await client.getLibraryRoomBookingResourceList(yyyymmdd, k.kindId);
                        rooms.push(...list.map((r) => ({
                            kindName: r.kindName,
                            roomName: r.roomName,
                            devName: r.devName,
                            minUser: r.minUser,
                            maxUser: r.maxUser,
                            minMinute: r.minMinute,
                            maxMinute: r.maxMinute,
                            openStart: r.openStart,
                            openEnd: r.openEnd,
                            booked: r.usage.map((u) => ({start: hhmm(new Date(u.start)), end: hhmm(new Date(u.end))})),
                        })));
                    } catch {
                        failedKinds.push(k.kindName);
                    }
                }
                if (rooms.length === 0 && failedKinds.length > 0) {
                    return fail("UPSTREAM_ERROR", `所有研讨间类别都查询失败：${failedKinds.join("、")}`);
                }
                return ok({date: dateStr, rooms, failedKinds});
            } catch (e) {
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
