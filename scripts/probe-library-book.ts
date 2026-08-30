/**
 * 图书馆座位"订+取消"真实链路验证（一次性探针，用户 2026-08-30 要求白天补测）。
 *
 * 流程：北馆明天 → 找第一个可约座位 → 订 → 查记录确认 → 取消 → 再查确认。
 * 会真实产生一条预约记录，随即取消，无费用。
 *
 * 注意（2026-08-30 实测踩坑）："当日取消次数"上限按【发起取消的日期】算，
 * 不按预约日期——今天取消明天的预约也占今天的额度。若今天额度已用完，
 * 探针会跳过取消环节（只验预约），存量预约可在官方 App 手动取消。
 *
 * 运行：OPENSSL_CONF=$PWD/openssl.cnf npx tsx scripts/probe-library-book.ts
 */
import {ThuClient} from "../src/client/ThuClient";

const client = new ThuClient();
await client.login();
console.log("登录成功");

const dateChoice = 1 as const; // 明天（见上方注释：当日取消次数有限）

// 馆 → 楼层 → 区域
const libs = (await client.getLibraryList()).filter((l) => l.valid && l.zhName.includes("北馆"));
if (libs.length !== 1) throw new Error(`北馆匹配异常：${libs.map((l) => l.zhName).join("、")}`);
const lib = libs[0];
console.log("馆：", lib.zhName);

const floors = (await client.getLibraryFloorList(lib, dateChoice)).filter((f) => f.valid);
const sections = (await Promise.all(floors.map((f) => client.getLibrarySectionList(f, dateChoice))))
    .flat()
    .filter((s) => s.valid && s.available > 0);
if (sections.length === 0) throw new Error("今天没有空位区域");
console.log(`有空位区域 ${sections.length} 个`);

// 找第一个可约座位
let chosen: {seat: Awaited<ReturnType<ThuClient["getLibrarySeatList"]>>[number];
    section: (typeof sections)[number]} | undefined;
for (const section of sections) {
    const seats = await client.getLibrarySeatList(section, dateChoice);
    const avail = seats.find((s) => s.status === "available");
    if (avail) { chosen = {seat: avail, section}; break; }
}
if (!chosen) throw new Error("有可约区域但拉不到可约座位");
console.log(`选定座位：${chosen.section.zhName} ${chosen.seat.zhName}（id=${chosen.seat.id}）`);

// 若已有可取消的存量预约，说明今天已无取消额度可用来清理它
// （或探针跑过一半），跳过新预约，避免再堆一条。
const pre = await client.getBookingRecords();
const existing = pre.find((r) => r.delId);
if (existing) {
    console.log(`已有可取消的存量预约：${existing.pos} ${existing.time}（${existing.status}）`);
    console.log("（2026-08-30 实测：当日取消次数已达上限，不再新订。明天再跑本探针完成取消验证。）");
    process.exit(0);
}

// 订
const bookResp = await client.bookLibrarySeat(
    {id: chosen.seat.id, type: chosen.seat.type}, chosen.section, dateChoice,
);
console.log("预约响应：status=", bookResp.status, "msg=", bookResp.msg);
if (bookResp.status !== 1) throw new Error(`预约失败：${bookResp.msg}`);

// 查记录确认（pos 形如 "北馆(李文正馆)-二层-A阅览区:NF2A003"）
const records = await client.getBookingRecords();
console.log("全部记录：", records.map((r) => `${r.pos} | ${r.time} | ${r.status} | delId=${r.delId ?? "无"}`));
const mine = records.find((r) => r.pos.includes(chosen!.seat.zhName) && r.delId);
if (!mine) throw new Error("预约成功但记录里找不到（或无取消入口）");
console.log(`记录确认：${mine.pos} ${mine.time} delId=${mine.delId ?? "(无)"}`);
if (!mine.delId) throw new Error("记录没有 delId，无法取消");

// 取消
await client.cancelBooking(mine.delId);
console.log("取消已提交");

// 再查确认
const after = await client.getBookingRecords();
const still = after.find((r) => r.pos.includes(chosen!.seat.zhName) && r.delId);
console.log(still ? "⚠️ 记录仍可取消：" + still.pos + " " + still.status : "✅ 记录已不可取消/消失，取消生效");
console.log("订+取消全链路验证完成。");
