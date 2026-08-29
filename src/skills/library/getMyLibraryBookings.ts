/**
 * Skill: get_my_library_bookings —— 查询我当前的图书馆预约（座位 + 研讨间）。
 *
 * 座位记录来自座位系统（pos 形如 "总馆 - 三层 A 区 A001"），delId 存在才可取消；
 * 研讨间记录来自研讨间系统（只查今天起 7 天内），uuid 用于取消。
 * 两类合并返回，模型可以直接把记录复述给用户，再配合 cancel_library_booking 取消。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface MySeatBooking {
    kind: "seat";
    /** 位置描述，如 "总馆 - 三层 A 区 A001" */
    pos: string;
    /** 时段描述（上游原文，如 "2026-08-29 08:00-22:00"） */
    time: string;
    status: string;
    /** 是否可取消（delId 存在 = 有取消入口） */
    cancellable: boolean;
}

export interface MyRoomBooking {
    kind: "room";
    roomName: string;
    kindName: string;
    date: string;
    begin: string;
    end: string;
    members: string[];
}

export interface MyLibraryBookingsData {
    seats: MySeatBooking[];
    rooms: MyRoomBooking[];
}

type BookingSource = Pick<ThuClient, "getBookingRecords" | "getLibraryRoomBookingRecord">;

const hhmm = (d: Date): string =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function createGetMyLibraryBookingsSkill(client: BookingSource): Skill {
    return {
        name: "get_my_library_bookings",
        description:
            "查询我当前的图书馆预约记录：座位预约和研讨间预约都会列出（位置/房间、日期时段、状态、成员）。" +
            "用户问“我约了哪个座位/研讨间”“我的图书馆预约”时调用；取消预约前也应先调用本工具拿到记录。",
        inputSchema: {type: "object", properties: {}, required: []},

        async execute(_input: unknown): Promise<SkillResult<MyLibraryBookingsData>> {
            try {
                // 两个系统互相独立，一个挂了不影响另一个
                const [seatRes, roomRes] = await Promise.allSettled([
                    client.getBookingRecords(),
                    client.getLibraryRoomBookingRecord(),
                ]);

                const seats: MySeatBooking[] = seatRes.status === "fulfilled"
                    ? seatRes.value.map((r) => ({
                        kind: "seat" as const,
                        pos: r.pos,
                        time: r.time,
                        status: r.status,
                        cancellable: r.delId !== undefined,
                    }))
                    : [];
                const rooms: MyRoomBooking[] = roomRes.status === "fulfilled"
                    ? roomRes.value.map((r) => ({
                        kind: "room" as const,
                        roomName: r.devName,
                        kindName: r.kindName,
                        date: r.date,
                        begin: hhmm(r.begin),
                        end: hhmm(r.end),
                        members: r.members.map((m) => m.name),
                    }))
                    : [];

                if (seatRes.status === "rejected" && roomRes.status === "rejected") {
                    const e = seatRes.reason;
                    if (e instanceof ThuError) return fail(e.code, e.message);
                    throw e;
                }
                return ok({seats, rooms});
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
