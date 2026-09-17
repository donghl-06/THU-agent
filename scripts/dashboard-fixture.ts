import {ok, fail, type Skill} from "../src/skills/base/types";
import {beijingDateString} from "../src/skills/learn/format";

/** Synthetic data exclusively for the offline UI fixture and regression tests. */
export function dashboardFixtureSkills(): Skill[] {
    const date = beijingDateString();
    const data: Record<string, unknown> = {
        get_campus_card_info: {balance: 128.6, cardStatus: "正常", lastTransactionTime: `${date}T04:15:00.000Z`, maxDailyTransactionAmount: 100},
        get_electricity: {kwhRemainder: 42.8, remainder: null, remainderNote: "金额余额源暂不可用", building: "紫荆学生公寓", room: "测试宿舍", meterTime: `${date} 08:00`, recentPayRecords: [{time: `${date} 09:20`, amount: "50.00", channel: "微信", status: "已成功"}]},
        get_learn_homework: {count: 3, homework: [
            {course: "数据结构", title: "第二次作业：线性表与栈", deadline: `${date} 23:59`, status: "unsubmitted", overdue: false, submissionType: "online", description: "完成线性表与栈的实现，提交代码与实验报告。"},
            {course: "概率论与数理统计", title: "习题课：条件概率", deadline: `${date} 23:59`, status: "unsubmitted", overdue: false, submissionType: "offline", description: "请在下一次习题课提交纸质作业。"},
            {course: "大学物理", title: "实验预习报告", deadline: "2020-01-01 23:59", status: "unsubmitted", overdue: true, submissionType: "online", description: "预习报告已过截止，请联系助教。"},
        ]},
        get_learn_notices: {count: 2, notices: [
            {course: "数据结构", title: "本周实验课安排与分组说明", publisher: "课程助教", publishTime: `${date} 09:30`, hasRead: false, markedImportant: true, content: "本周实验课请携带电脑，提前完成环境配置。<script>alert('untrusted')</script>"},
            {course: "概率论与数理统计", title: "课程参考资料已更新", publisher: "任课教师", publishTime: `${date} 08:10`, hasRead: false, markedImportant: false, content: "请查看最新上传的课程参考资料。"},
        ]},
        get_schedule: {date, dayOfWeek: 3, weekNumber: 2, semesterName: "2026–2027 学年秋季学期", courses: [{name: "数据结构", location: "六教 6A214", beginSession: 1, endSession: 2}, {name: "概率论与数理统计", location: "四教 4302", beginSession: 3, endSession: 4}]},
        get_campus_news: {mode: "latest", page: 1, limit: 30, channels: [], items: [
            {title: "关于本学期本科生选课调整的通知", date, source: "教务处", channelName: "教务通知", channel: "LM_JWGG", topped: true, url: "fixture-news-1"},
            {title: "图书馆秋季学期开放时间安排", date, source: "图书馆", channelName: "图书馆信息", channel: "LM_TTGGG", topped: false, url: "fixture-news-2"},
            {title: "校园文化活动与讲座预告", date, source: "学生工作部", channelName: "学生工作通知", channel: "LM_XSBGGG", topped: false, url: "fixture-news-3"},
        ]},
        get_campus_news_detail: {title: "校园资讯", content: "这是离线测试资讯正文。所有信息均为合成测试数据。", kind: "html", originalUrl: "", abstract: "", contentTruncated: false},
        get_my_library_bookings: {seats: [{kind: "seat", pos: "北馆 · 三层 A 区 021", time: `${date} 14:00–18:00`, status: "待签到", cancellable: true}], rooms: []},
        get_library_seats: {day: "today", totalAvailable: 326, sections: [{library: "北馆", floor: "三层", section: "A 区", total: 200, available: 128}, {library: "文科馆", floor: "二层", section: "阅览区", total: 300, available: 198}]},
        get_learn_courses: {semester: "2026-2027-1", count: 2, courses: [{name: "数据结构", teacher: "测试教师", courseNumber: "30240001", timeAndLocation: ["六教 6A214"]}, {name: "概率论与数理统计", teacher: "测试教师", courseNumber: "10420001", timeAndLocation: ["四教 4302"]}]},
        get_learn_files: {count: 1, files: [{course: "数据结构", title: "第二章 线性表.pdf", fileType: "pdf", size: "2.4 MB", uploadTime: `${date} 08:00`, isNew: true, downloadUrl: "https://learn.tsinghua.edu.cn/"}]},
        get_learn_calendar: {startDate: date, endDate: beijingDateString(13), events: [{date, courseName: "大学物理实验", startTime: "13:30", endTime: "15:05", location: "物理实验中心", status: "实验"}], homeworkDeadlines: []},
        get_emails: {mode: "list", count: 1, emails: [{uid: 1, subject: "本周学术讲座邀请", from: "校园学术活动", date: `${date} 10:00`, seen: false}]},
        get_report: {count: 2, courses: [{name: "微积分", credit: 5, grade: "A", point: 4, semester: "2025-2026-2"}, {name: "线性代数", credit: 4, grade: "A-", point: 3.7, semester: "2025-2026-2"}]},
        get_library_rooms: {date, rooms: [{kindName: "北馆", roomName: "研讨间", devName: "301", minUser: 3, maxUser: 6, minMinute: 30, maxMinute: 180, openStart: "08:00", openEnd: "22:00", booked: [{start: "14:00", end: "16:00"}]}], failedKinds: ["法律图书馆"]},
        get_sports_resources: {date, venues: [
            {name: "气膜馆羽毛球", sessions: [{time: "19:00-20:00", total: 8, availableFields: ["3 号场", "5 号场"], cost: 15}, {time: "20:00-21:00", total: 8, availableFields: [], cost: 15}]},
            {name: "综体羽毛球", sessions: [{time: "18:00-19:00", total: 6, availableFields: ["1 号场"], cost: 20}]},
        ]},
    };
    return [
        ...Object.entries(data).map(([name, value]) => ({name, description: "Offline dashboard fixture", inputSchema: {}, execute: async () => ok(value)})),
        {name: "get_network_status", description: "Offline unavailable network", inputSchema: {}, execute: async () => fail("NETWORK_AUTH_REQUIRED", "not configured")},
        {name: "get_dorm_score", description: "Offline unavailable dorm", inputSchema: {}, execute: async () => fail("DORM_SCORE_UNAVAILABLE", "not available")},
    ];
}
