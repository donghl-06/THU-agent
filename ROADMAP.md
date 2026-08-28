# THU Assistant Agent — 新手开发路线图（框架流程详解）

> 这份文档是给 **Agent 开发纯新手** 的落地指南。
> 它把 `plan4ai.md`（架构原则）和 `plan4me.md`（阶段规划）翻译成
> “每一步具体做什么、为什么这么做、怎么验证做对了”。
>
> 读完本文你应该能回答三个问题：
> 1. 我在做一个什么东西？（概念）
> 2. 它由哪几层组成，每层干什么？（架构）
> 3. 下一步具体敲什么命令、写什么代码？（行动）

---

## 第一部分：先搞懂概念（10 分钟）

### 1.1 什么是 Agent？和 Chatbot 有什么区别？

**Chatbot（聊天机器人）**：用户问 → 模型直接生成文字回答。模型只有“嘴”。

**Agent（智能体）**：用户问 → 模型判断“我需要先查点数据/做点事”→ 调用工具 →
拿到真实数据 → 再综合成回答。模型有“手”（工具）和“决策能力”（判断用哪只手）。

本项目的 Agent 长这样：

```text
用户: "我今晚没课的话想打羽毛球，帮我看看什么时候合适。"
                        │
                        ▼
              DeepSeek（大脑，负责推理）
                        │
            "我得先查他今天课表"  ← 模型自己决定的，不是我们写死的
                        │
                        ▼
              get_schedule（工具1）→ 真实课表数据
                        │
            "他 19 点后没课，再查羽毛球场地"
                        │
                        ▼
              get_sports_resources（工具2）→ 场地数据
                        │
                        ▼
              DeepSeek 综合两个结果：
              "你 19 点后没课，气膜馆 19:30-21:00 还有 2 片羽毛球场……"
```

**关键认知**：上面的流程里，"先查课表、再查场地"这个**计划是 LLM 临时推理出来的**，
不是我们写的 if-else。这就是 Agent 和传统 App 的本质区别。

### 1.2 三个核心术语

| 术语 | 是什么 | 本项目里对应 |
|---|---|---|
| **Skill（技能/工具）** | 一个原子能力：输入参数 → 返回结构化数据。如 `get_schedule` | 对 `@thu-info/lib` 某个 API 的薄封装 |
| **Function Calling（工具调用）** | LLM 的一种输出模式：模型不回答文字，而是输出"我要调用 get_schedule，参数是 {date: '2026-08-28'}"这样的结构化请求 | DeepSeek API 原生支持 |
| **Harness（运行时/支架）** | 我们自己写的调度代码：把工具清单告诉模型 → 收到模型的工具调用请求 → 执行对应 Skill → 把结果塞回对话 → 让模型继续。这个循环叫 **Agent Loop** | `src/harness/`（后期才写） |

### 1.3 为什么采用 Bottom-up（自底向上）开发？

新手最容易犯的错：**先搭一个花哨的 Agent 框架，再往里填功能**。
结果是框架很热闹，但每个工具都不靠谱，整体不可用。

本项目反着来：

```text
先把最底层的校园 API 跑通（能登录、能查课表）
        ↓
封装成稳定、可独立测试的 Skill
        ↓
最后才接 LLM（此时工具都已验证，出了问题容易定位）
```

**调试哲学**（plan4ai.md 第 9 节，非常重要）：

```text
Skill 单独测试失败      → 问题在 Skill / ThuClient / @thu-info/lib
Skill 单独测试成功但 Agent 失败 → 问题在 Harness / Prompt / 模型

分层测试让你永远知道"锅在哪一层"，不要把各层问题混在一起调。
```

---

## 第二部分：架构全景（四层职责）

```text
┌─────────────────────────────────────────────┐
│  第4层  DeepSeek Model                       │
│  职责：推理、决定调用哪个 Skill、组织自然语言回答  │
│  我们写什么：Prompt 和 API 调用（最后阶段）       │
├─────────────────────────────────────────────┤
│  第3层  DeepSeek Harness（src/harness/）       │
│  职责：注册工具、跑 Agent Loop、管理会话、       │
│        写操作前找用户确认                       │
│  我们写什么：调度循环代码（第 3 批工作）          │
├─────────────────────────────────────────────┤
│  第2层  THU Skills（src/skills/）             │
│  职责：校验输入 → 调 ThuClient → 规范化输出      │
│  我们写什么：5 个薄封装（第 2 批工作）★当前重点   │
├─────────────────────────────────────────────┤
│  第1层  ThuClient（src/client/）              │
│  职责：登录、Session 保活、重试、超时、错误归一化  │
│  我们写什么：对 @thu-info/lib 的统一包装         │
├─────────────────────────────────────────────┤
│  第0层  @thu-info/lib（参考仓库，我们不写）       │
│  职责：真正和清华服务器通信的 SDK               │
│  来源：reference/thu-info-app/packages/thu-info-lib │
└─────────────────────────────────────────────┘
```

**职责红线**（违反任何一条都会让项目迅速失控）：

- Skill **绝不**自己处理登录/Cookie/Session —— 那是 ThuClient 的事；
- Skill **绝不**包含 LLM 推理、Prompt、对话状态 —— 那是 Harness 的事；
- 我们**绝不**重写清华 Portal 的 HTTP 请求和页面解析 —— 那是 `@thu-info/lib` 已经做好的事；
- Harness **绝不**直接调 `@thu-info/lib` —— 必须经过 Skill。

---

## 第三部分：Skill 的统一长相（写代码前先看懂）

所有 Skill 遵循同一个接口（TypeScript）：

```typescript
// src/skills/base/types.ts —— 整个项目最重要的一个文件
interface Skill {
    name: string;           // 给模型看的名字，如 "get_schedule"
    description: string;    // 给模型看的说明，模型靠它决定何时调用
    inputSchema: object;    // JSON Schema，描述参数，模型靠它填参数
    execute(input: unknown): Promise<SkillResult>;
}

interface SkillResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: { code: string; message: string };
}
```

**为什么 `description` 和 `inputSchema` 这么重要？**
因为将来 Harness 会把它们原样发给 DeepSeek。模型**只通过这两个字段认识你的工具**。
description 写得含糊 → 模型乱调用；schema 写得含糊 → 模型乱填参数。

**什么能做 Skill / 什么不能**：

```text
✅ 原子能力：get_schedule / get_campus_card_info / get_library_seats
❌ 业务目标：plan_my_day / help_me_choose_course
   （这些是模型组合多个 Skill 完成的任务，不是一个 Skill）
```

**Read vs Write 安全边界**：

- **Read Skill**（查课表、查余额）：模型可以自主调用；
- **Write Skill**（预约、充值、选课、退课）：模型只能"提议"，
  必须由 Harness 把具体操作展示给用户、用户明确确认后才执行。
  第一版只实现 Read Skill。

---

## 第四部分：开发路线图（14 步，每步有验证标准）

> 严格按顺序做。每一步都有"完成标准"，达不到就不进下一步。

### 🟦 阶段 A：跑通底层（Step 0–3）— 证明"能和清华服务器说话"

**Step 0 · 环境初始化（本次已完成）**
- WSL2 + Node 22 + pnpm ✔
- 克隆参考仓库到 `reference/thu-info-app` ✔
- 初始化 `thu-assistant` 项目骨架 ✔

**Step 1 · 跑通 @thu-info/lib**
- 做什么：阅读 `reference/thu-info-app/packages/thu-info-lib/README.md`，
  按其说明在 Node 里创建 `InfoHelper` 实例。
- 完成标准：`new InfoHelper()` 不报错。

**Step 2 · 登录成功**
- 做什么：把清华账号密码放进 `.env`（**绝不写进代码、绝不提交 git**），
  写一个 `scripts/test-login.ts`，调用库的登录方法。
- 完成标准：终端打印"登录成功"并能看到自己的用户信息（如姓名/学号）。
- ⚠️ 遇到验证码/双因子：查库里有没有对应处理（参考仓库 demo 里有线索）。

**Step 3 · 拿到真实课表**
- 做什么：登录后调用 `getSchedule()`，把返回的 JSON 打印出来。
- 完成标准：终端看到本学期真实课程数据。
- 至此阶段 A 完成：**底层链路已通，且完全没碰 LLM**。

### 🟩 阶段 B：封装 Skills（Step 4–9）— 当前项目的核心工作

**Step 4 · 建立 ThuClient**
- 做什么：写 `src/client/ThuClient.ts`，把 Step 1–3 里散落的登录/调用逻辑收进一个类：
  `login()`、`getSchedule()`，统一处理错误和重试。
- 完成标准：把 Step 3 的脚本改成走 ThuClient，结果不变。

**Step 5 · 定义 Skill 接口**
- 做什么：写 `src/skills/base/types.ts`（上文第三部分的两个 interface）。
- 完成标准：文件能编译。这步代码很少，但它是全项目的"宪法"。

**Step 6 · 实现第一个 Skill：get_schedule**
- 做什么：`src/skills/schedule/getSchedule.ts` —— 校验输入（日期格式）
  → 调 `ThuClient.getSchedule()` → 把库返回的原始数据裁剪成稳定、简洁的 JSON
  （模型读不懂也不需要原始 HTML 和冗余字段）。
- 完成标准：`execute({date: "2026-08-28"})` 返回 `{success: true, data: {courses: [...]}}`。

**Step 7 · 给 get_schedule 写独立测试**
- 做什么：`tests/skills/getSchedule.test.ts`，**不依赖 DeepSeek、不依赖 Harness**，
  直接调 execute 断言返回结构。
- 完成标准：`pnpm test` 通过。

**Step 8 · 按优先级扩展另外 4 个 Read Skill**

```text
get_campus_card_info  →  get_classroom_state  →  get_library_seats  →  get_sports_resources
```

- 每加一个，重复 Step 6–7 的模式（实现 → 独立测试）。
- 不确定库 API 时：**查 `reference/thu-info-app/packages/thu-info-lib/src/`，不猜**。

**Step 9 · 五个 Skill 全部独立测试通过**
- 完成标准：`pnpm test` 全绿；每个 Skill 都能用一行 execute() 拿到稳定 JSON。
- 至此阶段 B 完成：**Agent 的"手"全部造好且都验过货**。

### 🟨 阶段 C：接入大脑（Step 10–12）— 第一次成为真正的 Agent

**Step 10 · 最小 DeepSeek Harness**
- 做什么：`src/harness/`，只做六件事：工具注册 → 生成 Tool Schema →
  调 DeepSeek API（带 tools 参数）→ 识别模型的 tool_calls → 执行对应 Skill →
  把结果以 tool 消息塞回对话，循环直到模型输出文字。
- **明确不做**：多 Agent、Planner、长期记忆、RAG、向量库、工作流引擎。
- 完成标准：Agent Loop 闭环能跑。

**Step 11 · 单 Skill Agent（V0.1 里程碑 🎉）**
- 测试句："我今天下午有什么课？"
- 完成标准：DeepSeek 自主决定调 get_schedule → 拿到真实数据 → 用自然语言回答。
  **这就是 plan4ai.md 第 18 节定义的第一个成功 Demo。**

**Step 12 · 多 Skill Agent（V0.2 里程碑 🎉🎉）**
- 测试句："我今晚没课的话想去打羽毛球，帮我看看什么时候合适。"
- 完成标准：模型自主串联 get_schedule + get_sports_resources 并给出建议。
  **此时系统真正具有 Agent 特征，不再是 API Chatbot。**

### 🟥 阶段 D：安全与评估（Step 13–14）— 从能跑到可信

**Step 13 · Write Skills + 用户确认**
- 加 `book_library_seat` 等写操作 Skill，Harness 里实现确认流：
  模型提议 → 终端展示"我将为你预约 某某馆 19:00-20:00 的座位，确认？(y/n)" →
  用户同意 → 才执行。

**Step 14 · Evaluation**
- 建 `eval/cases.json`（30–50 条测试问题，覆盖单 Skill、多 Skill、模糊问题、
  不该调工具的问题、敏感操作），写 `eval/runner.ts` 批量跑分：
  工具选择准确率、参数准确率、多余调用率、安全违规次数。

---

## 第五部分：项目目录（当前脚手架实际结构）

```text
THU-agent/                        ← 项目根（git 仓库）
├── plan4ai.md                    ← 给 AI 的架构约束（已存在）
├── plan4me.md                    ← 给人的阶段规划（已存在）
├── ROADMAP.md                    ← 本文档
├── reference/
│   └── thu-info-app/             ← 参考仓库（只读！已加入 .gitignore）
│       └── packages/thu-info-lib/ ← 第0层能力来源
├── src/
│   ├── client/                   ← 第1层 ThuClient（Step 4 建）
│   ├── skills/
│   │   └── base/types.ts         ← 第2层 Skill 接口（Step 5 建）
│   ├── harness/                  ← 第3层（Step 10 前保持空目录）
│   ├── config/                   ← 环境变量读取
│   └── index.ts
├── scripts/                      ← 一次性验证脚本（test-login.ts 等）
├── tests/                        ← Skill 独立测试
├── eval/                         ← 评估（Step 14 建）
├── .env.example                  ← 凭证模板（真实 .env 不进 git）
└── package.json
```

---

## 第六部分：新手避坑清单

1. **凭证安全**：密码/Cookie/Token 只放 `.env`；`.env` 必须在 `.gitignore` 里；
   日志里绝不打印敏感信息。提交前 `git status` 检查一遍。
2. **不猜 API**：`@thu-info/lib` 任何方法不确定，直接读
   `reference/thu-info-app/packages/thu-info-lib/src/` 和它的测试/demo。
3. **小步快跑**：每个 Step 完成就验证，不要攒三步再测。
4. **分层调试**：Skill 测试挂了查下层，Agent 挂了查上层，不混着查。
5. **抵制诱惑**：看到别人项目有 RAG/Memory/多 Agent 不要眼红 ——
   本项目 V0.2 之前一律不加，复杂度每加一层都要有真实需求证明。
6. **卡住时**：先确定卡在哪一层（用第五部分的目录对应），
   再把该层隔离出来单独复现。

---

## 附：速查 —— 我当前在哪一步？

```text
[已完成] Step 0  环境 + 脚手架
[已完成] Step 1  pnpm step1 — InfoHelper 实例化验证通过
[已完成] Step 2  pnpm step2 — 登录 + getUserInfo() 通过（2FA 信任设备、两处库补丁）
[已完成] Step 3  pnpm step3 — getSchedule() 真实数据链路打通（夏季学期无课属正常）
[已完成] Step 4  src/client/ThuClient.ts + auth.ts + errors.ts，step2/3 已改走 ThuClient
[已完成] Step 5  src/skills/base/types.ts（脚手架时已写）
[已完成] Step 6  get_schedule Skill（src/skills/schedule/getSchedule.ts）
[已完成] Step 7  独立测试 7 个全过（6 单测无网络 + 1 集成测试真实链路）
[已完成] Step 8  5 个 Read Skill 全部实现：
                  get_schedule / get_campus_card_info / get_classroom_state / get_library_seats / get_sports_resources
[已完成] Step 9  全部配双层独立测试（25 过 1 跳过）
                  ⚠️ get_sports_resources 集成测试暂停：50.tsinghua.edu.cn 经 webvpn 全站
                  PARSE_FAILED（上游故障，2026-08-28 确认），恢复后取消 it.skip 即可
[下一步] Step 10 最小 DeepSeek Harness（src/harness/）：工具注册 → Tool Schema →
                  Function Calling → 执行 → 结果回传 → Agent Loop
                  需要 .env 里填 DEEPSEEK_API_KEY
```
