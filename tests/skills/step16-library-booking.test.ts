/**
 * Step 16 图书馆预约/取消技能测试（罐头数据，无网络）。
 *
 * 重点：写操作的歧义拒绝（AMBIGUOUS）、上游 status 语义（1=成功）、
 * 研讨间规则校验（时段/时长/冲突/人数）、取消的记录匹配。
 */
import {describe, expect, it} from "vitest";
import {createGetMyLibraryBookingsSkill, type MyLibraryBookingsData} from "../../src/skills/library/getMyLibraryBookings";
import {createBookLibrarySeatSkill, type BookLibrarySeatData} from "../../src/skills/library/bookLibrarySeat";
import {createBookLibraryRoomSkill, type BookLibraryRoomData} from "../../src/skills/library/bookLibraryRoom";
import {createCancelLibraryBookingSkill, type CancelLibraryBookingData} from "../../src/skills/library/cancelLibraryBooking";
import {ThuError} from "../../src/client/errors";

type R<T> = {success: boolean; data?: T; error?: {code: string; message: string}};

// ---------- 公共罐头 ----------

const LIB = {id: 1, zhName: "总馆", zhNameTrace: "总馆", enName: "Main", enNameTrace: "Main", valid: true};
const FLOOR = {...LIB, id: 2, zhName: "三层", zhNameTrace: "总馆 - 三层"};
const SECTION = {...FLOOR, id: 3, zhName: "A区", zhNameTrace: "总馆 - 三层 A区", total: 100, available: 20, posX: 0, posY: 0};
const SEAT = {...SECTION, id: 301, zhName: "A001", type: 4, status: "available" as const};
const SEAT_BUSY = {...SEAT, id: 302, zhName: "A002", status: "unavailable" as const};

const seatClient = {
    getLibraryList: async () => [LIB],
    getLibraryFloorList: async () => [FLOOR],
    getLibrarySectionList: async () => [SECTION],
    getLibrarySeatList: async () => [SEAT, SEAT_BUSY],
    bookLibrarySeat: async () => ({status: 1, msg: ""}),
};

const ROOM_RES = {
    devId: 11, devName: "北馆3F-01", kindId: 1, kindName: "北馆单人研读间",
    labId: 1, labName: "", roomId: 1, roomName: "3F-01", limit: 0,
    maxMinute: 240, minMinute: 30, cancelMinute: 30, maxUser: 1, minUser: 1,
    openStart: "08:00", openEnd: "22:00",
    usage: [{id: 1, start: new Date("2026-08-29T10:00:00"), end: new Date("2026-08-29T12:00:00"), title: "", owner: "", ownerId: ""}],
};

const roomClient = {
    getLibraryRoomBookingInfoList: async () => [
        {kindId: 1, kindName: "北馆单人研读间", rooms: [{devId: 11, devName: "北馆3F-01", minReserveTime: 30}]},
    ],
    getLibraryRoomBookingResourceList: async () => [ROOM_RES],
    bookLibraryRoom: async () => {},
    fuzzySearchLibraryId: async (kw: string) =>
        kw === "2021001" ? [{id: 9001, label: "张*(**01)", department: "计算机系"}] : [],
};

// ---------- get_my_library_bookings ----------

describe("get_my_library_bookings Skill", () => {
    const client = {
        getBookingRecords: async () => [
            {id: "1", pos: "总馆 - 三层 A区 A001", time: "2026-08-29 08:00-22:00", status: "预约成功", delId: "abc"},
            {id: "2", pos: "总馆 - 三层 A区 A002", time: "2026-08-28 08:00-22:00", status: "已取消", delId: undefined},
        ],
        getLibraryRoomBookingRecord: async () => [{
            uuid: "u1", rsvId: 1, owner: "我", ownerId: "me", date: "20260830",
            begin: new Date("2026-08-30T14:00:00"), end: new Date("2026-08-30T16:00:00"),
            devName: "北馆3F-01", kindName: "北馆单人研读间", members: [{name: "我", userId: "me"}],
        }],
    };
    const skill = createGetMyLibraryBookingsSkill(client);

    it("座位+研讨间记录合并返回，delId 存在才标记可取消", async () => {
        const r = (await skill.execute({})) as R<MyLibraryBookingsData>;
        expect(r.success).toBe(true);
        expect(r.data!.seats).toHaveLength(2);
        expect(r.data!.seats[0].cancellable).toBe(true);
        expect(r.data!.seats[1].cancellable).toBe(false);
        expect(r.data!.rooms[0].begin).toBe("14:00");
        expect(r.data!.rooms[0].roomName).toBe("北馆3F-01");
    });

    it("一个系统挂了不影响另一个（降级）", async () => {
        const half = createGetMyLibraryBookingsSkill({
            getBookingRecords: async () => { throw new ThuError("UPSTREAM_ERROR", "座位系统挂了"); },
            getLibraryRoomBookingRecord: client.getLibraryRoomBookingRecord,
        });
        const r = (await half.execute({})) as R<MyLibraryBookingsData>;
        expect(r.success).toBe(true);
        expect(r.data!.seats).toEqual([]);
        expect(r.data!.rooms).toHaveLength(1);
    });

    it("两个系统都挂时报错", async () => {
        const dead = createGetMyLibraryBookingsSkill({
            getBookingRecords: async () => { throw new ThuError("UPSTREAM_ERROR", "座位挂了"); },
            getLibraryRoomBookingRecord: async () => { throw new ThuError("UPSTREAM_ERROR", "研讨间挂了"); },
        });
        const r = await dead.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("UPSTREAM_ERROR");
    });
});

// ---------- book_library_seat ----------

describe("book_library_seat Skill", () => {
    it("默认选第一个空位并下单成功", async () => {
        const skill = createBookLibrarySeatSkill(seatClient);
        const r = (await skill.execute({library: "总馆"})) as R<BookLibrarySeatData>;
        expect(r.success).toBe(true);
        expect(r.data!.seatName).toBe("A001");
        expect(r.data!.message).toContain("预约成功");
    });

    it("指定座位号精确匹配", async () => {
        const skill = createBookLibrarySeatSkill(seatClient);
        const r = (await skill.execute({library: "总馆", seatName: "A001"})) as R<BookLibrarySeatData>;
        expect(r.success).toBe(true);
        expect(r.data!.seatName).toBe("A001");
    });

    it("指定座位号不可约时报 NOT_AVAILABLE 并列出可约座位", async () => {
        const skill = createBookLibrarySeatSkill(seatClient);
        const r = await skill.execute({library: "总馆", seatName: "A002"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_AVAILABLE");
        expect(r.error!.message).toContain("A001");
    });

    it("馆关键词匹配多个时报 AMBIGUOUS", async () => {
        const twoLibs = createBookLibrarySeatSkill({
            ...seatClient,
            getLibraryList: async () => [LIB, {...LIB, id: 9, zhName: "总馆西馆"}],
        });
        const r = await twoLibs.execute({library: "总馆"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("AMBIGUOUS");
    });

    it("上游 status!==1 视为失败并透传 msg", async () => {
        const rejected = createBookLibrarySeatSkill({
            ...seatClient,
            bookLibrarySeat: async () => ({status: 0, msg: "您已有预约"}),
        });
        const r = await rejected.execute({library: "总馆"});
        expect(r.success).toBe(false);
        expect(r.error!.message).toContain("您已有预约");
    });

    it("没有空位区域时报 NOT_AVAILABLE", async () => {
        const full = createBookLibrarySeatSkill({
            ...seatClient,
            getLibrarySectionList: async () => [{...SECTION, available: 0}],
        });
        const r = await full.execute({library: "总馆"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_AVAILABLE");
    });
});

// ---------- book_library_room ----------

describe("book_library_room Skill", () => {
    it("单人研读间直接下单", async () => {
        const skill = createBookLibraryRoomSkill(roomClient);
        const r = (await skill.execute({keyword: "北馆", date: "2026-08-29", start: "14:00", end: "16:00"})) as R<BookLibraryRoomData>;
        expect(r.success).toBe(true);
        expect(r.data!.roomName).toBe("北馆3F-01");
        expect(r.data!.time).toBe("14:00-16:00");
    });

    it("与已订时段冲突时报 NOT_AVAILABLE", async () => {
        const skill = createBookLibraryRoomSkill(roomClient);
        const r = await skill.execute({keyword: "北馆", date: "2026-08-29", start: "11:00", end: "13:00"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_AVAILABLE");
    });

    it("超出开放时段被拒", async () => {
        const skill = createBookLibraryRoomSkill(roomClient);
        const r = await skill.execute({keyword: "北馆", date: "2026-08-29", start: "21:00", end: "23:00"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(r.error!.message).toContain("08:00-22:00");
    });

    it("时长低于 minMinute 被拒", async () => {
        const skill = createBookLibraryRoomSkill(roomClient);
        const r = await skill.execute({keyword: "北馆", date: "2026-08-29", start: "14:00", end: "14:15"});
        expect(r.success).toBe(false);
        expect(r.error!.message).toContain("30");
    });

    it("多人房间成员不足时报 MEMBERS_REQUIRED（未下单）", async () => {
        let booked = false;
        const groupRoom = createBookLibraryRoomSkill({
            ...roomClient,
            getLibraryRoomBookingResourceList: async () => [{...ROOM_RES, minUser: 3, maxUser: 6}],
            bookLibraryRoom: async () => { booked = true; },
        });
        const r = await groupRoom.execute({keyword: "北馆", date: "2026-08-29", start: "14:00", end: "16:00"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("MEMBERS_REQUIRED");
        expect(booked).toBe(false);
    });

    it("成员学号解析成功后带上成员下单", async () => {
        let gotMembers: number[] = [];
        const groupRoom = createBookLibraryRoomSkill({
            ...roomClient,
            getLibraryRoomBookingResourceList: async () => [{...ROOM_RES, minUser: 2, maxUser: 6}],
            bookLibraryRoom: async (_r: unknown, _s: string, _e: string, members: number[]) => { gotMembers = members; },
        });
        const r = await groupRoom.execute({keyword: "北馆", date: "2026-08-29", start: "14:00", end: "16:00", members: ["2021001"]});
        expect(r.success).toBe(true);
        expect(gotMembers).toEqual([9001]);
    });

    it("成员填姓名（非学号）时报 INVALID_INPUT（未下单）", async () => {
        let booked = false;
        const groupRoom = createBookLibraryRoomSkill({
            ...roomClient,
            getLibraryRoomBookingResourceList: async () => [{...ROOM_RES, minUser: 2, maxUser: 6}],
            bookLibraryRoom: async () => { booked = true; },
        });
        const r = await groupRoom.execute({keyword: "北馆", date: "2026-08-29", start: "14:00", end: "16:00", members: ["张三"]});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
        expect(booked).toBe(false);
    });

    it("学号查不到时报 NOT_FOUND（未下单）", async () => {
        let booked = false;
        const groupRoom = createBookLibraryRoomSkill({
            ...roomClient,
            getLibraryRoomBookingResourceList: async () => [{...ROOM_RES, minUser: 2, maxUser: 6}],
            bookLibraryRoom: async () => { booked = true; },
        });
        const r = await groupRoom.execute({keyword: "北馆", date: "2026-08-29", start: "14:00", end: "16:00", members: ["9999999"]});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
        expect(booked).toBe(false);
    });
});

// ---------- cancel_library_booking ----------

describe("cancel_library_booking Skill", () => {
    const cancelClient = {
        getBookingRecords: async () => [
            {id: "1", pos: "总馆 - 三层 A区 A001", time: "2026-08-29 08:00-22:00", status: "预约成功", delId: "del-1"},
            {id: "2", pos: "总馆 - 四层 B区 B001", time: "2026-08-29 08:00-22:00", status: "预约成功", delId: "del-2"},
        ],
        cancelBooking: async (_id: string) => {},
        getLibraryRoomBookingRecord: async () => [{
            uuid: "room-u1", rsvId: 1, owner: "我", ownerId: "me", date: "20260830",
            begin: new Date("2026-08-30T14:00:00"), end: new Date("2026-08-30T16:00:00"),
            devName: "北馆3F-01", kindName: "北馆单人研读间", members: [],
        }],
        cancelLibraryRoomBooking: async (_uuid: string) => {},
    };

    it("关键词唯一定位座位记录并取消", async () => {
        let cancelled = "";
        const skill = createCancelLibraryBookingSkill({
            ...cancelClient,
            cancelBooking: async (id: string) => { cancelled = id; },
        });
        const r = (await skill.execute({kind: "seat", keyword: "A001"})) as R<CancelLibraryBookingData>;
        expect(r.success).toBe(true);
        expect(cancelled).toBe("del-1");
        expect(r.data!.kind).toBe("seat");
    });

    it("匹配多条时报 AMBIGUOUS 且不取消任何记录", async () => {
        let cancelled = "";
        const skill = createCancelLibraryBookingSkill({
            ...cancelClient,
            cancelBooking: async (id: string) => { cancelled = id; },
        });
        const r = await skill.execute({kind: "seat"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("AMBIGUOUS");
        expect(r.error!.message).toContain("A001");
        expect(cancelled).toBe("");
    });

    it("研讨间记录按 uuid 取消，date 兼容 yyyyMMdd", async () => {
        let cancelled = "";
        const skill = createCancelLibraryBookingSkill({
            ...cancelClient,
            getBookingRecords: async () => [],
            cancelLibraryRoomBooking: async (uuid: string) => { cancelled = uuid; },
        });
        const r = await skill.execute({kind: "room", date: "2026-08-30"});
        expect(r.success).toBe(true);
        expect(cancelled).toBe("room-u1");
    });

    it("无匹配记录时报 NOT_FOUND", async () => {
        const skill = createCancelLibraryBookingSkill(cancelClient);
        const r = await skill.execute({kind: "seat", keyword: "不存在的座位"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
    });

    it("没有 delId 的记录不可取消", async () => {
        const skill = createCancelLibraryBookingSkill({
            ...cancelClient,
            getBookingRecords: async () => [
                {id: "1", pos: "总馆 - 三层 A区 A001", time: "2026-08-29 08:00", status: "已签到", delId: undefined},
            ],
            getLibraryRoomBookingRecord: async () => [],
        });
        const r = await skill.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
    });
});
