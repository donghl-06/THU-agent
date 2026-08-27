/**
 * Step 3 验证脚本：登录后调用 getSchedule() 拉取真实课表。
 *
 * 运行：pnpm step3
 * 完成标准：终端能看到本学期真实课程数据。
 *
 * 数据结构（来自 src/models/schedule/，不猜）：
 *   Schedule { name, location, activeTime: { base: TimeSlice[] } }
 *   TimeSlice { dayOfWeek, begin, end, activeWeeks }
 *   CalendarData { semesterName, firstDay, weekCount, nextSemesterList }
 */
import {InfoHelper} from "@thu-info/lib";
import {config} from "../src/config/env";

const helper = new InfoHelper();
helper.fingerprint = config.thu.fingerprint;
helper.trustFingerprintHook = async () => true;
helper.trustFingerprintNameHook = async () => "thu-assistant-dev";

console.log("正在登录……");
await helper.login({
    userId: config.thu.username,
    password: config.thu.password,
});
console.log("登录成功。");

console.log("正在获取课表……");
let {schedule, calendar} = await helper.getSchedule();

// 当前学期没课（如夏季学期）时，自动改查下一个学期，验证数据链路
if (schedule.length === 0 && calendar.nextSemesterList.length > 0) {
    console.log("当前学期无课程，尝试下一个学期……");
    ({schedule, calendar} = await helper.getSchedule(0));
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

console.log("\nStep 3 通过：getSchedule() 返回真实课表数据。");
console.log("下一阶段（Step 4）：建立 ThuClient，把登录/调用逻辑收进 src/client/。");
