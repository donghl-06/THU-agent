/**
 * 网络学堂（LearnClient）真链验证脚本。
 *
 * 运行：pnpm learn
 * 完成标准：终端能看到当前学期课程、最近通知、未交作业、课件数量和日历窗口。
 * 只读操作：不提交、不下载（提交作业请通过 Agent 走确认流程）。
 */
import {LearnClient} from "../src/client/learn/LearnClient";
import {ThuClient} from "../src/client/ThuClient";
import {config} from "../src/config/env";
import {formatBeijing} from "../src/skills/learn/format";

const thu = new ThuClient();
const learn = new LearnClient({
    credentials: {
        username: config.thu.username,
        password: config.thu.password,
        fingerprint: config.thu.fingerprint,
    },
    ensureDeviceTrusted: () => thu.login(),
});

console.log("正在登录网络学堂……");
const semester = await learn.getCurrentSemester();
console.log(`登录成功。当前学期：${semester.id}（${formatBeijing(semester.startDate)} ~ ${formatBeijing(semester.endDate)}）`);

const courses = await learn.getCourses();
console.log(`\n== 课程（${courses.length} 门）==`);
for (const c of courses) {
    console.log(`- ${c.chineseName || c.name} | ${c.teacherName} | ${c.courseNumber}`);
}

const firstCourse = courses[0];
if (firstCourse) {
    console.log(`\n== 「${firstCourse.chineseName}」最近 3 条通知 ==`);
    const notices = await learn.getNotifications(firstCourse.id);
    for (const n of notices.slice(0, 3)) {
        console.log(`- [${formatBeijing(n.publishTime)}] ${n.title}（${n.publisher}）${n.hasRead ? "" : " 【未读】"}`);
    }
    if (notices.length === 0) console.log("（无通知）");
}

console.log("\n== 全部课程未交作业（按截止升序）==");
let pending = 0;
for (const c of courses) {
    const homework = await learn.getHomeworkList(c.id);
    for (const h of homework.filter((h) => !h.submitted && !h.graded)) {
        pending++;
        const deadline = h.deadline instanceof Date && h.deadline.getTime() > 0
            ? formatBeijing(h.deadline)
            : "无截止时间";
        console.log(`- ${c.chineseName} | ${h.title} | 截止 ${deadline}`);
    }
}
if (pending === 0) console.log("（没有未交作业）");

if (firstCourse) {
    const files = await learn.getFileList(firstCourse.id);
    console.log(`\n== 「${firstCourse.chineseName}」课件：${files.length} 个 ==`);
    for (const f of files.slice(0, 3)) {
        console.log(`- ${f.title}（${f.size}，${formatBeijing(f.uploadTime)}）`);
    }
}

const today = new Date();
const yyyymmdd = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const in14days = new Date(today.getTime() + 13 * 24 * 3600 * 1000);
const events = await learn.getCalendar(yyyymmdd(today), yyyymmdd(in14days));
console.log(`\n== 未来 14 天学堂日历：${events.length} 个事件 ==`);
for (const e of events.slice(0, 5)) {
    console.log(`- ${e.date} ${e.startTime}-${e.endTime} ${e.courseName} @ ${e.location}`);
}

console.log("\n网络学堂链路验证通过：LearnClient → thu-learn-lib 全部只读接口正常。");
