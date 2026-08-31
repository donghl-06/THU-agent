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
import {createPaySportsOrderSkill} from "./sports/paySportsOrder";
import {createRechargeCampusCardSkill} from "./card/rechargeCampusCard";
import {MyhomeClient} from "../client/myhome";
import {createChaojiyingSolver} from "../client/captcha/chaojiying";
import {config} from "../config/env";
import type {LoginCredentials, TwoFactorHooks} from "../client/auth";

export interface SkillAssemblyOptions {
    /** 滑块验证码求解器。不提供且 .env 配了超级鹰（CJY_*）时自动用超级鹰；
     *  两者都没有时预约遇验证码会报 CAPTCHA_REQUIRED */
    captchaSolver?: CaptchaSolver;
    /** true 时装配后立刻后台预热登录态（首次提问不用再等登录） */
    prewarm?: boolean;
    /** 二次认证回调；Web UI 用它把认证交互转发到浏览器。 */
    authHooks?: TwoFactorHooks;
    /** 网页登录时传入的运行时凭证；不写入环境变量或日志。 */
    credentials?: LoginCredentials;
    /** 复用同一登录客户端，保证登录接口和 Skill 使用同一会话。 */
    thuClient?: ThuClient;
}

/** 求解器决策：显式传入优先，其次 .env 里的超级鹰配置（导出以便单测） */
export function resolveCaptchaSolver(override?: CaptchaSolver): CaptchaSolver | undefined {
    return override ?? (config.chaojiying.configured ? createChaojiyingSolver() : undefined);
}

export function createAllSkills(opts: SkillAssemblyOptions = {}): Skill[] {
    const thu = opts.thuClient ?? new ThuClient(opts.authHooks, opts.credentials);
    const sports = new SportsClient(opts.credentials);
    const captchaSolver = resolveCaptchaSolver(opts.captchaSolver);
    if (opts.prewarm) {
        // 后台预热登录态，失败不影响启动（首个工具调用会重试登录）
        void thu.login().catch(() => {});
    }
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
        // 体育场待支付订单 → 支付方式（二维码/链接/学校支付平台表单，同样不动钱）
        createPaySportsOrderSkill(sports),
        // 校园卡充值：微信/支付宝扫码二维码（扫码前钱不动）
        createRechargeCampusCardSkill(thu),
    ];
}
