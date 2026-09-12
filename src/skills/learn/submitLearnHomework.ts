/**
 * Skill: submit_learn_homework —— 提交网络学堂作业（写操作，真实生效）。
 *
 * 安全红线（plan4ai.md）：requiresConfirmation = true，Harness 必须先向用户
 * 展示「提交什么文件到哪门课的哪个作业」并拿到明确同意才会执行到这里。
 *
 * 匹配规则同其他写操作：课程和作业都必须唯一匹配，歧义时报 AMBIGUOUS
 * 让模型回去问，绝不能随便挑一个交。重复提交会覆盖上一次提交内容（学堂行为）。
 */
import {readFile} from "node:fs/promises";
import {basename} from "node:path";
import type {Homework} from "thu-learn-lib";
import {ThuError} from "../../client/errors";
import type {LearnClient} from "../../client/learn/LearnClient";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {courseDisplayName, resolveUniqueCourse, type CourseSource} from "./courseResolve";
import {formatBeijing} from "./format";

/** 学堂附件大小的保守上限（ learnX 未显式限制，这里挡掉明显选错的文件） */
const MAX_FILE_BYTES = 500 * 1024 * 1024;

export interface SubmitLearnHomeworkData {
    course: string;
    homework: string;
    filename: string;
    sizeBytes: number;
    /** 是否是覆盖已有的提交 */
    overwritten: boolean;
    message: string;
}

type SubmitSource = CourseSource & Pick<LearnClient, "getHomeworkList" | "submitHomework">;

/** 作业标题关键词唯一匹配（写操作规则同课程匹配） */
function matchHomework(
    list: Homework[],
    keyword: string,
    courseName: string,
): {homework?: Homework; error?: SkillResult<never>} {
    const kw = keyword.trim().toLowerCase();
    const matched = list.filter((h) => h.title.toLowerCase().includes(kw));
    if (matched.length === 0) {
        const titles = list.map((h) => h.title).join("、") || "（这门课还没有作业）";
        return {
            error: fail(
                "NOT_FOUND",
                `「${courseName}」找不到标题含“${keyword}”的作业。现有作业：${titles}`,
            ),
        };
    }
    if (matched.length > 1) {
        return {
            error: fail(
                "AMBIGUOUS",
                `“${keyword}”匹配到 ${matched.length} 个作业：${matched.map((h) => h.title).join("、")}。请说完整作业标题。`,
            ),
        };
    }
    return {homework: matched[0]};
}

export function createSubmitLearnHomeworkSkill(client: SubmitSource): Skill {
    return {
        name: "submit_learn_homework",
        description:
            "提交网络学堂（learn.tsinghua.edu.cn）作业（写操作，真实生效）。" +
            "把本地文件（通常是 PDF）作为附件提交到指定课程的指定作业，可附文字说明。" +
            "课程和作业标题都必须是能唯一匹配的关键词；拿不准时先用 get_learn_courses / get_learn_homework 确认。" +
            "重复提交会覆盖上次提交。只能交线上作业（submissionType=online）。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                course: {
                    type: "string",
                    description: "课名关键词，必须能唯一匹配一门课，如“数据结构”",
                },
                homework: {
                    type: "string",
                    description: "作业标题关键词，必须能唯一匹配一个作业，如“第三次作业”",
                },
                filePath: {
                    type: "string",
                    description: "本地文件绝对路径（如 /home/user/hw3.pdf），将作为作业附件上传",
                },
                content: {
                    type: "string",
                    description: "可选，随作业提交的文字说明",
                },
            },
            required: ["course", "homework", "filePath"],
        },

        async execute(input: unknown): Promise<SkillResult<SubmitLearnHomeworkData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            for (const k of ["course", "homework", "filePath"] as const) {
                if (typeof raw[k] !== "string" || !(raw[k] as string).trim()) {
                    return fail("INVALID_INPUT", `${k} 必填且必须是非空字符串`);
                }
            }
            if (raw.content !== undefined && typeof raw.content !== "string") {
                return fail("INVALID_INPUT", "content 必须是字符串");
            }

            try {
                // 第一级：课程（唯一匹配）
                const {course, error} = await resolveUniqueCourse(client, raw.course as string);
                if (error) return error;
                const courseName = courseDisplayName(course!);

                // 第二级：作业（唯一匹配）
                const list = await client.getHomeworkList(course!.id);
                const {homework, error: hwError} = matchHomework(
                    list,
                    raw.homework as string,
                    courseName,
                );
                if (hwError) return hwError;
                const hw = homework!;

                // 可提交性检查
                if (hw.submissionType === 0) {
                    return fail(
                        "NOT_SUBMITTABLE",
                        `「${hw.title}」是线下作业（不需要在学堂提交），请按老师要求线下完成。`,
                    );
                }
                const now = Date.now();
                const finalDeadline = hw.lateSubmissionDeadline ?? hw.deadline;
                if (finalDeadline instanceof Date && finalDeadline.getTime() > 0 && finalDeadline.getTime() < now) {
                    return fail(
                        "DEADLINE_PASSED",
                        `「${hw.title}」已于 ${formatBeijing(finalDeadline)} 截止，无法提交。`,
                    );
                }

                // 读文件
                const filePath = (raw.filePath as string).trim();
                let buffer: Buffer;
                try {
                    buffer = await readFile(filePath);
                } catch {
                    return fail("FILE_NOT_FOUND", `读不到文件：${filePath}（请确认路径存在且可读）`);
                }
                if (buffer.length === 0) {
                    return fail("INVALID_INPUT", `文件是空的：${filePath}`);
                }
                if (buffer.length > MAX_FILE_BYTES) {
                    return fail(
                        "INVALID_INPUT",
                        `文件 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超过 500MB 上限，请压缩后再试。`,
                    );
                }
                const filename = basename(filePath);

                await client.submitHomework(hw.id, (raw.content as string | undefined) ?? "", {
                    filename,
                    content: new Blob([new Uint8Array(buffer)]),
                });

                const lateNote =
                    hw.lateSubmissionDeadline && hw.deadline instanceof Date && hw.deadline.getTime() < now
                        ? "（迟交，已记入迟交时间）"
                        : "";
                return ok({
                    course: courseName,
                    homework: hw.title,
                    filename,
                    sizeBytes: buffer.length,
                    overwritten: hw.submitted,
                    message:
                        `已提交：${filename} → 「${courseName}」的「${hw.title}」${lateNote}。` +
                        (hw.submitted ? "之前的提交已被覆盖。" : ""),
                });
            } catch (e) {
                if (e instanceof ThuError) return fail(e.code, e.message);
                throw e;
            }
        },
    };
}
