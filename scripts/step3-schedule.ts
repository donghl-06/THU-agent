/**
 * Step 3 验证脚本：通过 ThuClient 调用 getSchedule() 拉取真实课表。
 *
 * 运行：pnpm step3
 * 完成标准：终端能看到学期信息与课程数据（夏季学期无课属正常）。
 *
 * 数据结构（来自 src/models/schedule/，不猜）：
 *   Schedule { name, location, activeTime: { base: TimeSlice[] } }
 *   TimeSlice { dayOfWeek, begin, end, activeWeeks }
 *   CalendarData { semesterName, firstDay, weekCount, nextSemesterList }
 */
import {ThuClient} from "../src/client/ThuClient";

const client = new ThuClient();

console.log("正在登录……");
await client.login();
console.log("登录成功。");

console.log("正在获取课表……");
let {schedule, calendar} = await client.getSchedule();

// 当前学期没课（如夏季学期）时，自动改查下一个学期，验证数据链路
if (schedule.length === 0 && calendar.nextSemesterList.length > 0) {
    console.log("当前学期无课程，尝试下一个学期……");
    ({schedule} = await client.getSchedule(0));
}

console.log(`\n学期：${calendar.semesterName}（开学日 ${calendar.firstDay}，共 ${calendar.weekCount} 周）`);
console.log(`共 ${schedule.length} 门课程/安排：\n`);
for (const item of schedule) {
    for (const slice of item.activeTime.base) {
        console.log(
            `- ${item.name} | 星期${slice.dayOfWeek} 第${slice.begin}-${slice.end}节` +
            ` | 第${slice.activeWeeks.join(",")}周 | ${item.location || "地点未知"}`,
        );
    }
}

console.log("\nStep 3 通过：ThuClient → @thu-info/lib 课表链路正常。");
