/**
 * Skill: get_learn_homework —— 查询网络学堂的课程作业。
 *
 * 读操作扇出：course 省略时聚合本学期全部课程的作业，按截止时间升序
 * （最紧急的在前）。status 过滤：unsubmitted 未交 / submitted 已交 / graded 已批改。
 * 线上作业（submissionType=online）才能用 submit_learn_homework 提交。
 */
import type {Homework} from "thu-learn-lib";
import {ThuError} from "../../client/errors";
import type {LearnClient} from "../../client/learn/LearnClient";
import {extractInlineImages, type InlineImage} from "../../utils/htmlImages";
import {htmlToText} from "../../utils/htmlToText";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, resolveCourses, type CourseSource} from "./courseResolve";
import {formatBeijing} from "./format";

export interface LearnHomeworkItem {
    course: string;
    title: string;
    /** 状态：unsubmitted 未交 / submitted 已交 / graded 已批改 */
    status: "unsubmitted" | "submitted" | "graded";
    /** 截止时间（北京时间 "2026-09-20 23:59"）；无截止时间为 null */
    deadline: string | null;
    /** 是否已过截止（仅未交时有意义） */
    overdue: boolean;
    /** online=线上提交 / offline=线下完成（如实验报告交纸质版） */
    submissionType: "online" | "offline";
    /** 作业要求（纯文本，正文内嵌图片留 [图片N] 占位） */
    description?: string;
    /** 作业要求里直接贴的内嵌图片；可用 show_learn_image 的 homework 参数显示 */
    images?: InlineImage[];
    /** 提交时间（已交时） */
    submittedAt?: string;
    /** 成绩（分数或等级如 A-/已阅，已批改时） */
    grade?: string;
    gradeComment?: string;
    graderName?: string;
}

export interface LearnHomeworkData {
    count: number;
    homework: LearnHomeworkItem[];
}

type HomeworkSource = CourseSource & Pick<LearnClient, "getHomeworkList">;

const STATUS_VALUES = ["unsubmitted", "submitted", "graded", "all"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

/** 学堂域名：作业描述内嵌图片的相对路径按它解析成绝对 URL */
const LEARN_BASE_URL = "https://learn.tsinghua.edu.cn";

function statusOf(h: Homework): "unsubmitted" | "submitted" | "graded" {
    if (h.graded) return "graded";
    if (h.submitted) return "submitted";
    return "unsubmitted";
}

/** deadline 可能缺失或是 epoch 0，统一归一成 null */
function validDeadline(h: Homework): Date | null {
    return h.deadline instanceof Date && h.deadline.getTime() > 0 ? h.deadline : null;
}

export function createGetLearnHomeworkSkill(client: HomeworkSource): Skill {
    return {
        name: "get_learn_homework",
        description:
            "查询网络学堂（learn.tsinghua.edu.cn）的课程作业：标题、截止时间、提交状态、成绩评语。" +
            "作业要求里直接贴的图片会提取到 images 字段，用户要看图时用 show_learn_image 的 homework 参数显示。" +
            "course 给课名关键词查对应课程，省略时聚合本学期全部课程，按截止时间升序（最紧急在前）。" +
            "status 可过滤 unsubmitted（未交，问“有什么作业要交”时用）/ submitted / graded（问成绩时用）。",
        inputSchema: {
            type: "object",
            properties: {
                course: {
                    type: "string",
                    description: "可选，课名/课号关键词，如“数据结构”；省略时查全部课程",
                },
                status: {
                    type: "string",
                    enum: [...STATUS_VALUES],
                    description: "可选，按状态过滤，默认 all",
                },
                limit: {
                    type: "number",
                    description: "可选，最多返回多少条，默认 30",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<LearnHomeworkData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (raw.course !== undefined && typeof raw.course !== "string") {
                return fail("INVALID_INPUT", "course 必须是字符串（课名关键词）");
            }
            const status: StatusFilter = (raw.status as StatusFilter | undefined) ?? "all";
            if (!STATUS_VALUES.includes(status)) {
                return fail("INVALID_INPUT", `status 只能是 ${STATUS_VALUES.join(" / ")}`);
            }
            const limit = raw.limit === undefined ? 30 : Number(raw.limit);
            if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
                return fail("INVALID_INPUT", "limit 必须是 1-200 的整数");
            }
            try {
                const {result, error} = await resolveCourses(client, raw.course as string | undefined);
                if (error) return error;
                const perCourse = await Promise.all(
                    result!.courses.map(async (c) => ({
                        name: courseDisplayName(c),
                        homework: await client.getHomeworkList(c.id),
                    })),
                );
                const now = Date.now();
                const homework = perCourse
                    .flatMap(({name, homework}) =>
                        homework
                            .filter((h) => status === "all" || statusOf(h) === status)
                            .map((h) => ({course: name, raw: h})),
                    )
                    // 截止时间升序（最紧急在前），无截止时间的排最后
                    .sort((a, b) => {
                        const da = validDeadline(a.raw)?.getTime() ?? Number.MAX_SAFE_INTEGER;
                        const db = validDeadline(b.raw)?.getTime() ?? Number.MAX_SAFE_INTEGER;
                        return da - db;
                    })
                    .slice(0, limit)
                    .map(({course, raw: h}): LearnHomeworkItem => {
                        const deadline = validDeadline(h);
                        const s = statusOf(h);
                        const desc = h.description
                            ? extractInlineImages(h.description, LEARN_BASE_URL)
                            : undefined;
                        return {
                            course,
                            title: h.title,
                            status: s,
                            deadline: deadline ? formatBeijing(deadline) : null,
                            overdue: s === "unsubmitted" && deadline !== null && deadline.getTime() < now,
                            submissionType:
                                h.submissionType === 0 ? "offline" : "online",
                            ...(desc ? {description: desc.text} : {}),
                            ...(desc && desc.images.length > 0 ? {images: desc.images} : {}),
                            ...(h.submitTime ? {submittedAt: formatBeijing(h.submitTime)} : {}),
                            ...(h.grade !== undefined
                                ? {grade: String(h.grade)}
                                : h.gradeLevel
                                    ? {grade: h.gradeLevel}
                                    : {}),
                            ...(h.gradeContent ? {gradeComment: htmlToText(h.gradeContent)} : {}),
                            ...(h.graderName ? {graderName: h.graderName} : {}),
                        };
                    });
                if (homework.length === 0) {
                    return fail(
                        "NOT_FOUND",
                        status === "unsubmitted"
                            ? "没有未交的作业"
                            : status === "all"
                                ? "没有查到任何作业"
                                : `没有状态为 ${status} 的作业`,
                    );
                }
                return ok({count: homework.length, homework});
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
