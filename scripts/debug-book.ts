/**
 * 一次性调试：带详细日志真实执行一次 book_sports_field
 * （用户已确认并明确要求实测：2026-08-30 06:00 气膜馆 羽02）。
 * 会真实下单（PAY_OFFLINE，不产生线上扣款，可在"我的预约"取消）。
 */
import "../src/utils/httpProxy";
import {SportsClient} from "../src/client/sports/SportsClient";
import {createChaojiyingSolver} from "../src/client/captcha/chaojiying";
import {createBookSportsFieldSkill} from "../src/skills/sports/bookSportsField";

const sports = new SportsClient();

const origCheck = sports.checkDragCaptcha.bind(sports);
sports.checkDragCaptcha = async (cap, x) => {
    const ok = await origCheck(cap, x);
    console.log(`  drag/check X=${x} → ${ok ? "✅ 通过" : "❌ 未通过"}`);
    return ok;
};

const skill = createBookSportsFieldSkill(sports, {captchaSolver: createChaojiyingSolver()});
console.log("开始执行预约：2026-08-30 06:00 气膜馆羽毛球 羽02");
const r = await skill.execute({
    resourceName: "气膜馆羽毛球",
    date: "2026-08-30",
    sessionStart: "06:00",
    fieldName: "羽02",
});
console.log("\n结果：");
console.log(JSON.stringify(r, null, 2));
