import type {DashboardContent, DashboardGroup, DashboardItem, DashboardMetric} from "../shared/dashboard";
import {dashboardLink} from "../shared/dashboard";
import type {CampusCardData} from "../skills/card/getCampusCardInfo";
import type {ElectricityData} from "../skills/dorm/getElectricity";
import type {NetworkStatusData} from "../skills/network/getNetworkStatus";
import type {ScheduleData} from "../skills/schedule/getSchedule";
import type {CampusNewsData} from "../skills/news/getCampusNews";
import type {LearnCoursesData} from "../skills/learn/getLearnCourses";
import type {LearnHomeworkData} from "../skills/learn/getLearnHomework";
import type {LearnNoticesData} from "../skills/learn/getLearnNotices";
import type {LearnFilesData} from "../skills/learn/getLearnFiles";
import type {LearnCalendarData} from "../skills/learn/getLearnCalendar";
import type {LibrarySeatsData} from "../skills/library/getLibrarySeats";
import type {LibraryRoomData} from "../skills/library/getLibraryRooms";
import type {MyLibraryBookingsData} from "../skills/library/getMyLibraryBookings";
import type {ReportData} from "../skills/academic/getReport";
import type {GetEmailsData} from "../skills/mail/getEmails";
import type {DormScoreData} from "../skills/dorm/getDormScore";
import {beijingDateString} from "../skills/learn/format";

export interface DashboardSource {
    id: string;
    title: string;
    group: DashboardGroup;
    description: string;
    skill: string;
    intervalMs: number;
    input: () => Record<string, unknown>;
    normalize: (data: unknown) => DashboardContent;
    emptyOnNotFound?: boolean;
}

const metric = (label: string, value: string | number | null, unit?: string): DashboardMetric => ({label, value: value === null || (typeof value === "number" && !Number.isFinite(value)) ? "—" : String(value), unit});
const money = (value: number | null) => value !== null && Number.isFinite(value) ? value.toFixed(2) : null;
const join = (...values: (string | undefined)[]) => values.filter(Boolean).join(" · ");
const today = () => ({date: beijingDateString()});
const noInput = () => ({});

function source<T>(id: string, title: string, group: DashboardGroup, description: string, minutes: number, skill: string,
    normalize: (data: T) => DashboardContent, input = noInput, emptyOnNotFound = false): DashboardSource {
    return {id, title, group, description, intervalMs: minutes * 60_000, skill, input, normalize: data => normalize(data as T), emptyOnNotFound};
}

/** A presentation allowlist over createAllSkills(), not a second executable tool registry. */
export const dashboardSources: DashboardSource[] = [
    source<CampusCardData>("card", "校园卡", "life", "余额、卡片状态与最近交易", 2, "get_campus_card_info", d => ({
        metrics: [metric("校园卡余额", money(d.balance), "元")],
        items: [{title: d.cardStatus || "卡片状态未提供", subtitle: `单日消费限额 ${d.maxDailyTransactionAmount} 元`, time: d.lastTransactionTime}],
    })),
    source<LearnHomeworkData>("homework", "待交作业", "learning", "本学期未提交作业，最多 200 项", 5, "get_learn_homework", d => {
        const overdue = d.homework.filter(h => h.overdue);
        const upcoming = d.homework.filter(h => !h.overdue);
        return {
            metrics: [metric("待交作业", d.count, "项"), metric("已过截止", overdue.length, "项")],
            items: [...upcoming, ...overdue].map(h => ({title: h.title, subtitle: join(h.course, h.submissionType === "offline" ? "线下提交" : "线上提交"), time: h.deadline ?? "未设截止时间", badge: h.overdue ? "已过截止" : "待提交", attention: h.overdue, body: h.description})),
            note: d.count >= 200 ? "仅展示前 200 项，更多作业请到网络学堂查看。" : undefined,
        };
    }, () => ({status: "unsubmitted", limit: 200}), true),
    source<LearnNoticesData>("notices", "学堂公告", "learning", "本学期各课程最新 30 条公告", 5, "get_learn_notices", d => ({
        metrics: [metric("最近公告中未读", d.notices.filter(n => !n.hasRead).length, "条")],
        items: d.notices.map(n => ({title: n.title, subtitle: join(n.course, n.publisher), time: n.publishTime, badge: n.markedImportant ? "重要" : !n.hasRead ? "未读" : undefined, attention: n.markedImportant, body: n.content})),
    }), () => ({limit: 30}), true),
    source<ScheduleData>("schedule", "今日课表", "learning", "教务课程安排 · 北京时间", 15, "get_schedule", d => ({
        metrics: [metric("今日课程", d.courses.length, "门")],
        items: d.courses.map(c => ({title: c.name, subtitle: c.location || "地点待定", time: `第 ${c.beginSession}–${c.endSession} 节`})),
        note: d.note ?? join(d.semesterName, d.weekNumber === null ? undefined : `第 ${d.weekNumber} 周`, d.date),
    }), today),
    source<CampusNewsData>("news", "校园资讯", "campus", "Info 最新通知、教务公告与校园动态", 10, "get_campus_news", d => ({
        items: d.items.map(n => ({title: n.title, subtitle: join(n.channelName, n.source), time: n.date, badge: n.topped ? "置顶" : undefined, newsRef: n.url})),
    }), () => ({limit: 30})),
    source<ElectricityData>("electricity", "宿舍电量", "life", "剩余电量、余额与最近缴费", 5, "get_electricity", d => ({
        metrics: [metric("剩余电量", d.kwhRemainder, "度"), metric("电费余额", money(d.remainder), "元")],
        items: d.recentPayRecords.map(r => ({title: `${r.amount} 元 · ${r.status}`, subtitle: r.channel, time: r.time})),
        note: join(d.building, d.room, d.meterTime ? `抄表 ${d.meterTime}` : d.kwhRemainder === null ? "电量暂不可用" : undefined, d.remainderNote),
    })),
    source<NetworkStatusData>("network", "校园网络", "life", "账户余额、本月用量与在线设备", 5, "get_network_status", d => ({
        metrics: [metric("网络账户余额", d.balance.accountBalance), metric("本月流量", d.balance.usedBytes), metric("在线设备", d.devices.length, "台")],
        items: d.devices.map((device, i) => ({title: `设备 ${i + 1}`, subtitle: device.authPermission, time: device.loggedAt})),
        note: join(d.balance.productName, `已用时长 ${d.balance.usedSeconds}`, `结算 ${d.balance.settlementDate}`),
    })),
    source<MyLibraryBookingsData>("bookings", "我的图书馆预约", "life", "座位预约与未来 7 天研讨间预约", 5, "get_my_library_bookings", d => ({
        metrics: [metric("预约记录", d.seats.length + d.rooms.length, "条")],
        items: [...d.seats.map(s => ({title: s.pos, time: s.time, badge: s.status})), ...d.rooms.map(r => ({title: join(r.kindName, r.roomName), time: `${r.date} ${r.begin}–${r.end}`, badge: "研讨间"}))],
        note: "座位与研讨间来自独立系统，单个系统不可用时仅显示另一系统的记录。",
    })),
    source<LibrarySeatsData>("seats", "图书馆空位", "campus", "今天各馆区可用座位", 3, "get_library_seats", d => ({
        metrics: [metric("可用座位", d.totalAvailable, "个")],
        items: d.sections.map(s => ({title: join(s.library, s.floor, s.section), subtitle: `共 ${s.total} 个座位`, badge: `${s.available} 空位`})),
    }), () => ({day: "today"})),
    source<LearnCoursesData>("courses", "本学期课程", "learning", "网络学堂课程、教师与上课地点", 30, "get_learn_courses", d => ({
        metrics: [metric("学堂课程", d.count, "门")],
        items: d.courses.map(c => ({title: c.name, subtitle: join(c.teacher, c.courseNumber), body: c.timeAndLocation.join("\n")})), note: d.semester,
    }), noInput, true),
    source<LearnFilesData>("files", "最新课件", "learning", "本学期各课程最近上传的 30 份文件", 15, "get_learn_files", d => ({
        items: d.files.map(f => ({title: f.title, subtitle: join(f.course, f.size), time: f.uploadTime, badge: f.isNew ? "新文件" : undefined, body: f.description, href: dashboardLink(f.downloadUrl)})),
        note: "文件链接需要浏览器已登录网络学堂。",
    }), () => ({limit: 30}), true),
    source<LearnCalendarData>("calendar", "近期日程", "learning", "网络学堂未来 14 天课程、考试与作业截止", 15, "get_learn_calendar", d => ({
        items: [
            ...d.events.map(e => ({title: e.courseName, subtitle: e.location, time: `${e.date} ${e.startTime}–${e.endTime}`, badge: e.status})),
            ...d.homeworkDeadlines.filter(h => h.status === "unsubmitted").map(h => ({title: h.title, subtitle: h.course, time: h.deadline, badge: "作业截止"})),
        ].sort((a, b) => a.time.localeCompare(b.time)), note: `${d.startDate} 至 ${d.endDate} · 北京时间`,
    })),
    source<GetEmailsData>("emails", "清华邮箱", "life", "收件箱最近 15 封邮件", 5, "get_emails", d => ({
        items: (d.emails ?? []).map(e => ({title: e.subject || "（无主题）", subtitle: e.from, time: e.date, badge: e.seen ? undefined : "未读"})),
        note: "仅显示邮件摘要，阅读正文请前往邮箱或在对话中查询。",
    }), () => ({limit: 15}), true),
    source<ReportData>("report", "课程成绩", "learning", "各学期课程成绩与学分", 60, "get_report", d => ({
        metrics: [metric("成绩记录", d.count, "门")],
        items: [...d.courses].sort((a, b) => b.semester.localeCompare(a.semester)).map(c => ({title: c.name, subtitle: `${c.semester} · ${c.credit} 学分`, badge: c.grade, body: `绩点 ${c.point}`})),
    }), noInput, true),
    source<LibraryRoomData>("rooms", "图书馆研讨间", "campus", "今日开放时间与已预约时段", 10, "get_library_rooms", d => ({
        items: d.rooms.map(r => ({title: join(r.kindName, r.roomName, r.devName), subtitle: `${r.minUser}–${r.maxUser} 人`, time: r.openStart && r.openEnd ? `${r.openStart}–${r.openEnd}` : "开放时间未提供", body: r.booked.length ? `已预约：${r.booked.map(b => `${b.start}–${b.end}`).join("、")}` : "未查询到已预约时段"})),
        note: d.failedKinds.length ? `以下类别暂未获取：${d.failedKinds.join("、")}` : `${d.date} · 可预约状态以提交时为准`,
    }), today),
    source<DormScoreData>("dorm", "宿舍卫生", "life", "最近四周卫生检查公示", 60, "get_dorm_score", d => ({
        images: d.imagesBase64.filter(value => /^[A-Za-z0-9+/=\r\n]+$/.test(value)).slice(0, 4).map(value => `data:image/png;base64,${value}`), note: d.note,
    })),
];

// Keep payloads bounded even when an upstream service sends very large text fields.
export function boundDashboardContent(content: DashboardContent): DashboardContent {
    const trim = (value?: string) => value?.slice(0, 8000);
    return {...content, note: trim(content.note), items: content.items?.slice(0, 500).map((item): DashboardItem => ({
        ...item, title: item.title.slice(0, 400), subtitle: trim(item.subtitle), body: trim(item.body),
    }))};
}
