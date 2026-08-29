/**
 * 技能装配：用真实 client 创建全部 Skill。
 * Harness 和脚本从这里拿技能清单，不各自散着 new。
 */
import {ThuClient} from "../client/ThuClient";
import {SportsClient} from "../client/sports/SportsClient";
import type {Skill} from "./base/types";
import {createGetScheduleSkill} from "./schedule/getSchedule";
import {createGetCampusCardInfoSkill} from "./card/getCampusCardInfo";
import {createGetClassroomStateSkill} from "./classroom/getClassroomState";
import {createGetLibrarySeatsSkill} from "./library/getLibrarySeats";
import {createGetSportsResourcesSkill} from "./sports/getSportsResources";
import {createGetReportSkill} from "./academic/getReport";
import {createGetElectricitySkill} from "./dorm/getElectricity";
import {createGetLibraryRoomsSkill} from "./library/getLibraryRooms";
import {createBookSportsFieldSkill, type CaptchaSolver} from "./sports/bookSportsField";
import {createGetMyLibraryBookingsSkill} from "./library/getMyLibraryBookings";
import {createBookLibrarySeatSkill} from "./library/bookLibrarySeat";
import {createBookLibraryRoomSkill} from "./library/bookLibraryRoom";
import {createCancelLibraryBookingSkill} from "./library/cancelLibraryBooking";
import {createRechargeElectricitySkill} from "./dorm/rechargeElectricity";
import {MyhomeClient} from "../client/myhome";
import {createChaojiyingSolver} from "../client/captcha/chaojiying";
import {config} from "../config/env";

export interface SkillAssemblyOptions {
    /** 滑块验证码求解器。不提供且 .env 配了超级鹰（CJY_*）时自动用超级鹰；
     *  两者都没有时预约遇验证码会报 CAPTCHA_REQUIRED */
    captchaSolver?: CaptchaSolver;
}

/** 求解器决策：显式传入优先，其次 .env 里的超级鹰配置（导出以便单测） */
export function resolveCaptchaSolver(override?: CaptchaSolver): CaptchaSolver | undefined {
    return override ?? (config.chaojiying.configured ? createChaojiyingSolver() : undefined);
}

export function createAllSkills(opts: SkillAssemblyOptions = {}): Skill[] {
    const thu = new ThuClient();
    const sports = new SportsClient();
    const captchaSolver = resolveCaptchaSolver(opts.captchaSolver);
    return [
        createGetScheduleSkill(thu),
        createGetCampusCardInfoSkill(thu),
        createGetClassroomStateSkill(thu),
        createGetLibrarySeatsSkill(thu),
        createGetSportsResourcesSkill(sports),
        // Step 15：扩充的读技能（电费带 m.myhome 电量源，比 lib 通道稳）
        createGetReportSkill(thu),
        createGetElectricitySkill(thu, new MyhomeClient()),
        createGetLibraryRoomsSkill(thu),
        // Step 16：我的图书馆预约（取消场景前置查询）
        createGetMyLibraryBookingsSkill(thu),
        // 写操作：Harness 会在执行前向用户确认（requiresConfirmation）
        createBookSportsFieldSkill(sports, {captchaSolver}),
        createBookLibrarySeatSkill(thu),
        createBookLibraryRoomSkill(thu),
        createCancelLibraryBookingSkill(thu),
        // 电费充值：生成支付宝扫码付款链接（扫码半自动，扫码前钱不动）
        createRechargeElectricitySkill(thu),
    ];
}
