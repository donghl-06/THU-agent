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
import {createBookSportsFieldSkill} from "./sports/bookSportsField";

export function createAllSkills(): Skill[] {
    const thu = new ThuClient();
    const sports = new SportsClient();
    return [
        createGetScheduleSkill(thu),
        createGetCampusCardInfoSkill(thu),
        createGetClassroomStateSkill(thu),
        createGetLibrarySeatsSkill(thu),
        createGetSportsResourcesSkill(sports),
        // 写操作：Harness 会在执行前向用户确认（requiresConfirmation）
        createBookSportsFieldSkill(sports),
    ];
}
