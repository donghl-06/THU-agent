/**
 * ThuClient —— Agent 项目与 @thu-info/lib 之间的统一适配层（plan4ai.md 第 4.2 节）。
 *
 * 职责：
 *   - InfoHelper 生命周期与登录会话管理
 *   - 凭证 / 指纹 / 设备信任（见 auth.ts）
 *   - 网络错误的有限重试（清华服务器偶发超时，官方 README 建议重试）
 *   - 错误归一化（见 errors.ts）
 *
 * 非职责：业务参数校验、输出裁剪 —— 那是 Skill 层的事。
 *
 * 注意：只在确认可用后才添加新的 API 包装方法，不提前堆方法。
 *
 * 体育场馆查询不在这里：旧系统 50.tsinghua.edu.cn 已下线，
 * 新系统由 src/client/sports/SportsClient.ts 单独封装（见 docs/sports-api-notes.md）。
 */
import {InfoHelper} from "@thu-info/lib";
import {config} from "../config/env";
import {setupAuth, type TwoFactorHooks} from "./auth";
import {normalizeError, ThuError} from "./errors";

/** login() 遇到网络类错误时的最大尝试次数（含首次） */
const LOGIN_MAX_ATTEMPTS = 3;

export class ThuClient {
    private readonly helper: InfoHelper;
    private loggedIn = false;

    constructor(hooks: TwoFactorHooks = {}) {
        this.helper = new InfoHelper();
        setupAuth(this.helper, hooks);
    }

    /**
     * 登录（幂等）。网络类错误自动重试，认证类错误直接抛出。
     */
    async login(): Promise<void> {
        if (this.loggedIn) return;
        let lastError: ThuError | undefined;
        for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt++) {
            try {
                await this.helper.login({
                    userId: config.thu.username,
                    password: config.thu.password,
                });
                this.loggedIn = true;
                return;
            } catch (e) {
                lastError = normalizeError(e);
                if (lastError.code !== "NETWORK_ERROR" && lastError.code !== "TIMEOUT") {
                    throw lastError; // 认证/服务端错误重试无意义
                }
            }
        }
        throw lastError;
    }

    /** 内部统一调用入口：确保已登录 + 错误归一化 */
    private async call<T>(fn: () => Promise<T>): Promise<T> {
        await this.login();
        try {
            return await fn();
        } catch (e) {
            throw normalizeError(e);
        }
    }

    /** 获取课表。nextSemesterIndex 省略时查当前学期 */
    // ReturnType 对 async 方法已含 Promise，不要再包一层
    async getSchedule(nextSemesterIndex?: number): ReturnType<InfoHelper["getSchedule"]> {
        return this.call(() => this.helper.getSchedule(nextSemesterIndex));
    }

    /** 获取当前用户基本信息（姓名、邮箱名） */
    async getUserInfo(): ReturnType<InfoHelper["getUserInfo"]> {
        return this.call(() => this.helper.getUserInfo());
    }

    /** 获取校园卡信息（余额、卡片状态等） */
    async getCampusCardInfo(): ReturnType<InfoHelper["getCampusCardInfo"]> {
        return this.call(() => this.helper.getCampusCardInfo());
    }

    /** 获取学期日历（开学日、周数等） */
    async getCalendar(): ReturnType<InfoHelper["getCalendar"]> {
        return this.call(() => this.helper.getCalendar());
    }

    /** 获取可查询的教学楼列表（含查询用的 searchName 与当前周次） */
    async getClassroomList(): ReturnType<InfoHelper["getClassroomList"]> {
        return this.call(() => this.helper.getClassroomList());
    }

    /** 获取某教学楼某周的教室占用状态（42 格 = 7 天 × 每天 6 个时段） */
    async getClassroomState(
        building: string,
        week: number,
    ): ReturnType<InfoHelper["getClassroomState"]> {
        return this.call(() => this.helper.getClassroomState(building, week));
    }

    /** 获取图书馆馆区列表（总馆、文科馆等） */
    async getLibraryList(): ReturnType<InfoHelper["getLibraryList"]> {
        return this.call(() => this.helper.getLibraryList());
    }

    /** 获取某馆的楼层列表。dateChoice：0 今天 / 1 明天 */
    async getLibraryFloorList(
        library: Parameters<InfoHelper["getLibraryFloorList"]>[0],
        dateChoice: 0 | 1,
    ): ReturnType<InfoHelper["getLibraryFloorList"]> {
        return this.call(() => this.helper.getLibraryFloorList(library, dateChoice));
    }

    /** 获取某楼层的区域列表（含座位总数/空位数）。dateChoice：0 今天 / 1 明天 */
    async getLibrarySectionList(
        floor: Parameters<InfoHelper["getLibrarySectionList"]>[0],
        dateChoice: 0 | 1,
    ): ReturnType<InfoHelper["getLibrarySectionList"]> {
        return this.call(() => this.helper.getLibrarySectionList(floor, dateChoice));
    }

    /** 获取成绩单（全部学期课程：名称/学分/等级/绩点）。bx=true 附带必限任标记 */
    async getReport(): ReturnType<InfoHelper["getReport"]> {
        return this.call(() => this.helper.getReport(true, true));
    }

    /** 获取宿舍电费余额与更新时间（上游可能返回 remainder=null + "暂时无法查询"） */
    async getEleRemainder(): ReturnType<InfoHelper["getEleRemainder"]> {
        return this.call(() => this.helper.getEleRemainder());
    }

    /** 获取宿舍电费缴费记录（[账号, 订单号, 时间, 渠道, 金额, 状态][] 元组） */
    async getElePayRecord(): ReturnType<InfoHelper["getElePayRecord"]> {
        return this.call(() => this.helper.getElePayRecord());
    }

    /** 发起电费充值（支付宝通道），返回 payCode；
     *  拼成 https://qr.alipay.com/<payCode> 即为扫码付款链接。
     *  只生成待支付订单，用户扫码前钱不动 */
    async getEleRechargePayCode(money: number): ReturnType<InfoHelper["getEleRechargePayCode"]> {
        return this.call(() => this.helper.getEleRechargePayCode(money));
    }

    /** 获取图书馆研讨间的类别列表（kindId/kindName + 房间） */
    async getLibraryRoomBookingInfoList(): ReturnType<InfoHelper["getLibraryRoomBookingInfoList"]> {
        return this.call(() => this.helper.getLibraryRoomBookingInfoList());
    }

    /** 获取某研讨间类别某天的房间资源与占用。date: yyyyMMdd */
    async getLibraryRoomBookingResourceList(
        date: string,
        kindId: number,
    ): ReturnType<InfoHelper["getLibraryRoomBookingResourceList"]> {
        return this.call(() => this.helper.getLibraryRoomBookingResourceList(date, kindId));
    }

    /** 获取某区域的座位明细（id/zhName/status: available|unavailable|unknown）。dateChoice：0 今天 / 1 明天 */
    async getLibrarySeatList(
        section: Parameters<InfoHelper["getLibrarySeatList"]>[0],
        dateChoice: 0 | 1,
    ): ReturnType<InfoHelper["getLibrarySeatList"]> {
        return this.call(() => this.helper.getLibrarySeatList(section, dateChoice));
    }

    /** 预约图书馆座位。返回 {status, msg}，status===1 成功，0 失败（msg 带原因） */
    async bookLibrarySeat(
        seat: Parameters<InfoHelper["bookLibrarySeat"]>[0],
        section: Parameters<InfoHelper["bookLibrarySeat"]>[1],
        dateChoice: 0 | 1,
    ): ReturnType<InfoHelper["bookLibrarySeat"]> {
        return this.call(() => this.helper.bookLibrarySeat(seat, section, dateChoice));
    }

    /** 我的座位预约记录（id/pos/time/status/delId——delId 存在才可取消） */
    async getBookingRecords(): ReturnType<InfoHelper["getBookingRecords"]> {
        return this.call(() => this.helper.getBookingRecords());
    }

    /** 取消座位预约。id 用记录里的 delId */
    async cancelBooking(id: string): ReturnType<InfoHelper["cancelBooking"]> {
        return this.call(() => this.helper.cancelBooking(id));
    }

    /** 我的研讨间预约记录（uuid 用于取消；仅查今天起 7 天内） */
    async getLibraryRoomBookingRecord(): ReturnType<InfoHelper["getLibraryRoomBookingRecord"]> {
        return this.call(() => this.helper.getLibraryRoomBookingRecord());
    }

    /** 取消研讨间预约 */
    async cancelLibraryRoomBooking(uuid: string): ReturnType<InfoHelper["cancelLibraryRoomBooking"]> {
        return this.call(() => this.helper.cancelLibraryRoomBooking(uuid));
    }

    /** 按姓名/学号模糊查用户（研讨间加成员用）：返回 {id, label, department} */
    async fuzzySearchLibraryId(keyword: string): ReturnType<InfoHelper["fuzzySearchLibraryId"]> {
        return this.call(() => this.helper.fuzzySearchLibraryId(keyword));
    }

    /** 预约研讨间。start/end 形如 "yyyy-MM-dd HH:mm"；memberList 是其他成员的用户 id（不含自己） */
    async bookLibraryRoom(
        roomRes: Parameters<InfoHelper["bookLibraryRoom"]>[0],
        start: string,
        end: string,
        memberList: number[],
    ): ReturnType<InfoHelper["bookLibraryRoom"]> {
        return this.call(() => this.helper.bookLibraryRoom(roomRes, start, end, memberList));
    }
}
