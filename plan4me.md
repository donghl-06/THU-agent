# 清华小助手 Agent 项目开发计划与路线指导

## 1. 项目目标

本项目目标是构建一个面向清华大学校园生活场景的智能体（THU Assistant Agent）。

用户不再需要像传统 App 一样手动进入不同页面查询课表、校园卡、图书馆、体育场馆等信息，而可以直接通过自然语言表达需求，由 Agent 自主判断需要调用哪些校园能力，并综合多个信息源完成任务。

例如：

> 用户：我今晚没课的话想去打羽毛球，帮我看看什么时候合适。

Agent 应能够：

1. 查询用户今日课表；
2. 判断晚间空闲时间；
3. 查询体育场馆资源；
4. 综合两个 Skill 的结果；
5. 给出合适时间和场地建议；
6. 如果未来涉及真正预约，则在执行写操作前请求用户确认。

因此，本项目的核心并不是“把清华信息 App 改成聊天界面”，而是：

> 将已有校园服务转化为 Agent 可以自主调用和组合的 Skills，再通过 DeepSeek Harness 构建完整 Agent。

---

# 2. 已有项目基础

参考项目：

`thu-info-community/thu-info-app`

该项目是一个使用 React Native 开发的清华校园信息聚合 App。

项目中最值得本 Agent 使用的部分并不是 React Native UI，而是：

`packages/thu-info-lib`

其中的 `@thu-info/lib` 本身就是一个面向程序调用的清华 Web Portal 接口库。它已经提供大量校园相关 API，包括：

* 用户信息
* 课表
* 教室
* 图书馆
* 图书馆座位与房间
* 校园新闻
* 校园卡
* 宿舍与电费
* 校园网络
* 体育场馆
* 选课
* 教学评价
* 成绩相关信息
* 其他校园服务

因此本项目不应该重新实现这些清华接口，而应：

```text
@thu-info/lib
      ↓
封装
      ↓
THU Skills
      ↓
DeepSeek Harness
      ↓
THU Assistant Agent
```

---

# 3. 总体架构

推荐的最终架构：

```text
                    User
                     │
                     ▼
              DeepSeek Model
                     │
              reasoning / planning
                     │
                tool calling
                     ▼
            DeepSeek Harness
        ┌────────────┼────────────┐
        │            │            │
     Session      Permission    Routing
        │            │            │
        └────────────┼────────────┘
                     │
                     ▼
                Skill Layer
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   Schedule      Library       Sports
     Skill        Skill         Skill
        │            │            │
        └────────────┼────────────┘
                     ▼
                  ThuClient
                     │
                     ▼
               @thu-info/lib
                     │
                     ▼
             Tsinghua Services
```

各层职责需要严格分离。

---

# 4. 各层职责

## 4.1 @thu-info/lib

定位：

> 清华校园能力 SDK。

它负责真正和清华校园服务交互。

例如：

```text
getSchedule
getCampusCardInfo
getClassroomState
getLibrarySeatList
getSportsResources
```

Agent 层原则上不重新实现这些底层请求。

---

## 4.2 ThuClient

定位：

> Agent 项目与 `@thu-info/lib` 之间的统一适配层。

主要负责：

* 初始化 InfoHelper；
* 登录；
* Session 管理；
* Cookie / credential 生命周期；
* API 调用；
* Retry；
* Timeout；
* 将底层异常统一转换；
* 对返回数据做必要清洗。

例如：

```text
ThuClient
├── login()
├── getSchedule()
├── getCampusCardInfo()
├── getLibrarySeats()
└── getSportsResources()
```

注意：

**Skill 不应该自己管理登录、Cookie 和 Session。**

---

# 5. Skill 层

Skill 是 Agent 可以使用的能力。

例如：

```text
get_schedule
get_classroom_state
get_campus_card_info
get_library_seats
get_sports_resources
```

一个 Skill 应尽量满足：

* 名字清晰；
* description 清晰；
* 输入参数明确；
* 输出结构稳定；
* 可以独立调用；
* 可以独立测试；
* 不依赖具体 LLM；
* 不依赖具体 Harness。

推荐统一接口：

```text
name
description
input_schema
output_schema
execute()
```

例如：

```typescript
get_schedule

description:
查询当前用户在指定日期的课程安排。

input:
{
    date?: string
}

output:
{
    success: boolean,
    courses: [...]
}
```

---

# 6. Harness 层

Harness 不负责实现校园功能。

Harness 的职责是：

* 将 Skills 注册给模型；
* 维护 Agent Loop；
* 将 Tool Schema 提供给 DeepSeek；
* 执行 Tool Call；
* 把 Skill Result 返回模型；
* 管理上下文；
* Session 管理；
* 权限控制；
* Retry；
* Timeout；
* 用户确认；
* Logging。

可以简单理解成：

```text
DeepSeek
    ↓
我要调用 get_schedule
    ↓
Harness
    ↓
找到并执行 get_schedule
    ↓
返回结果
    ↓
DeepSeek
    ↓
继续推理
```

---

# 7. 开发阶段

整个项目不要一次完成。

推荐拆成以下阶段。

---

## Phase 0：环境与底层 API 验证

### 目标

确认 `@thu-info/lib` 可以正常工作。

### 工作

推荐环境：

```text
Windows
  +
WSL2 Ubuntu
  +
VS Code Remote WSL
```

首先：

```bash
git clone https://github.com/thu-info-community/thu-info-app.git
```

然后进入项目。

重点研究：

```text
packages/thu-info-lib/
```

项目 README 已经提供 Node.js 使用方式，包括构建 `thu-info-lib`、创建 `InfoHelper` 并登录。

### 第一个任务

只做：

```text
login
+
getSchedule()
```

确保能够在终端看到真实课表数据。

### 完成标准

```text
Node Script
    ↓
Login
    ↓
getSchedule()
    ↓
成功返回数据
```

此阶段完全不要 DeepSeek。

---

# 8. Phase 1：功能盘点

目标：

> 确定 Agent 第一版究竟会什么。

不要一开始把几十个 API 全做成 Skills。

第一版建议仅实现五类能力：

### Skill 1

```text
get_schedule
```

用途：

* 今天有什么课？
* 明天下午有没有课？
* 我晚上几点有空？

---

### Skill 2

```text
get_classroom_state
```

用途：

* 六教有没有空教室？
* 哪里可以自习？

---

### Skill 3

```text
get_campus_card_info
```

用途：

* 校园卡余额是多少？

---

### Skill 4

```text
get_library_seats
```

用途：

* 图书馆哪里还有座位？
* 某楼层有没有空位？

---

### Skill 5

```text
get_sports_resources
```

用途：

* 今晚有没有羽毛球场？
* 哪个体育馆还有场地？

完成这五个 Skill 后再扩大范围。

---

# 9. Phase 2：Skill Schema 设计

在真正写 Skill 前，先统一格式。

例如：

```typescript
interface Skill {
    name: string;

    description: string;

    inputSchema: object;

    execute(input: unknown): Promise<SkillResult>;
}
```

统一返回：

```typescript
interface SkillResult<T> {
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}
```

这一阶段重点不是实现很多代码。

重点是确定：

> “以后所有 Skills 应该长什么样？”

---

# 10. Phase 3：实现 ThuClient

不要让 Skill 直接操作 `InfoHelper`。

推荐：

```text
src/
├── client/
│   ├── ThuClient.ts
│   ├── auth.ts
│   └── errors.ts
```

例如：

```typescript
class ThuClient {

    async login() {}

    async getSchedule() {}

    async getCampusCardInfo() {}

    async getLibrarySeats() {}
}
```

然后 Skill：

```text
get_schedule
       ↓
ThuClient.getSchedule()
       ↓
@thu-info/lib
```

这样以后底层 API 发生变化，只需要修改 ThuClient。

---

# 11. Phase 4：实现第一批 Skills

推荐目录：

```text
thu-assistant/
│
├── src/
│
│   ├── client/
│   │   ├── ThuClient.ts
│   │   └── errors.ts
│   │
│   ├── skills/
│   │
│   │   ├── base/
│   │   │   └── types.ts
│   │   │
│   │   ├── schedule/
│   │   │   └── getSchedule.ts
│   │   │
│   │   ├── classroom/
│   │   │   └── getClassroomState.ts
│   │   │
│   │   ├── card/
│   │   │   └── getCampusCardInfo.ts
│   │   │
│   │   ├── library/
│   │   │   └── getLibrarySeats.ts
│   │   │
│   │   └── sports/
│   │       └── getSportsResources.ts
│   │
│   └── index.ts
│
├── tests/
│
├── config/
│
└── package.json
```

---

# 12. Phase 5：Skill 独立测试

这一点非常重要。

每个 Skill 必须可以在没有 LLM、没有 Harness 的情况下执行。

例如：

```typescript
const result = await getScheduleSkill.execute({
    date: "2026-08-28"
});

console.log(result);
```

应该直接得到：

```json
{
  "success": true,
  "data": {
    "courses": []
  }
}
```

这样可以建立明确的问题边界：

```text
Skill 单测失败
→ THU API / ThuClient / Skill 问题

Skill 单测成功
但 Agent 失败
→ Model / Prompt / Harness 问题
```

---

# 13. Phase 6：接入 DeepSeek Harness

只有当至少 3～5 个 Skill 能独立运行时再做 Harness。

第一版 Harness 只需要解决：

```text
Skills 注册
+
DeepSeek Tool Calling
+
Tool Execution
+
Result Return
+
Agent Loop
```

例如：

```text
用户：
我今天下午有什么课？

        ↓

DeepSeek

        ↓

get_schedule({
    date: "..."
})

        ↓

Harness

        ↓

Skill

        ↓

结果

        ↓

DeepSeek

        ↓

自然语言答案
```

此阶段暂时不要加入复杂：

* 多 Agent；
* 长期 Memory；
* Code Mode；
* Planner Agent；
* 向量数据库；
* RAG；
* Workflow Engine。

先把最简单的 Agent Loop 跑通。

---

# 14. Phase 7：多 Skill Agent

这是项目真正开始有价值的阶段。

测试：

> “我今晚没课的话想打羽毛球，帮我找一个合适时间。”

期望：

```text
Agent
 │
 ├─ get_schedule
 │
 ├─ 分析空闲时间
 │
 ├─ get_sports_resources
 │
 └─ 综合回答
```

这比传统 App 最大的优势就在于：

> 自动组合不同校园能力完成一个目标。

---

# 15. Phase 8：安全与权限

Skills 应分为两类。

## Read Skills

例如：

```text
get_schedule
get_balance
get_library_seats
get_sports_resources
```

原则：

Agent 可以自主调用。

## Write Skills

例如：

```text
book_library_seat

cancel_booking

make_sports_reservation

select_course

delete_course

recharge_campus_card

report_campus_card_loss
```

这些底层写操作在 `@thu-info/lib` 中已经存在。

原则：

```text
Agent 决定想执行
      ↓
展示具体操作
      ↓
用户确认
      ↓
Harness Authorization
      ↓
Skill Execute
```

禁止模型自行执行有真实后果的操作。

---

# 16. Phase 9：Evaluation

准备：

```text
eval/
├── cases.json
└── runner.ts
```

建立至少 30～50 个问题。

测试类型：

### 单 Skill

```text
我今天下午有什么课？
```

### 参数理解

```text
帮我看看下周三下午的课。
```

### 多 Skill

```text
如果我今晚没课，帮我找一个可以打羽毛球的时间。
```

### 模糊问题

```text
我下午去哪儿？
```

### Skill 不应该调用

```text
清华是哪一年建校的？
```

### 敏感操作

```text
帮我直接把这门课退了。
```

记录：

```text
Task Success Rate
Tool Selection Accuracy
Parameter Accuracy
Unnecessary Tool Calls
Average Tool Calls
Latency
Safety Violations
```

---

# 17. 推荐开发顺序

当前严格按照：

```text
Step 1
跑通 thu-info-lib

↓

Step 2
跑通 login

↓

Step 3
跑通 getSchedule

↓

Step 4
建立 ThuClient

↓

Step 5
设计 Skill Interface

↓

Step 6
完成 get_schedule Skill

↓

Step 7
为 get_schedule 写测试

↓

Step 8
扩展到 5 个 Read Skills

↓

Step 9
每个 Skill 独立测试

↓

Step 10
接 DeepSeek Harness

↓

Step 11
跑通单 Skill Agent

↓

Step 12
跑通 Multi-Skill Agent

↓

Step 13
增加 Write Skills + Confirmation

↓

Step 14
Benchmark + 优化
```

---

# 18. 当前阶段最重要的原则

## 原则一：先能力，后智能

不要一开始研究复杂 Prompt。

首先确保：

```text
校园服务本身可调用。
```

---

## 原则二：Skill 与 Harness 解耦

Skill 不应该知道：

```text
DeepSeek
Prompt
Agent Context
Agent Loop
```

Skill 只负责：

```text
input
↓
execute
↓
output
```

---

## 原则三：先 Read，后 Write

第一版 Agent 只查询。

等架构稳定后再开放：

```text
预约
取消
充值
选课
退课
```

---

## 原则四：先 5 个 Skills，不做 50 个

Skill 数量不是 Agent 能力的核心指标。

更重要的是：

```text
是否可靠
是否容易选择
参数是否准确
是否能够组合
```

---

## 原则五：每增加一个复杂层，都要有理由

不要因为 Agent 项目里常见就自动加入：

```text
RAG
Memory
Planner
Multi-Agent
Vector Database
MCP
```

只有在实际需求出现之后再加入。

---

# 19. 第一个真正的项目里程碑

当前阶段只追求一个结果：

```text
用户：
“我今天下午有什么课？”

↓

DeepSeek

↓

get_schedule

↓

@thu-info/lib

↓

真实课表数据

↓

DeepSeek

↓

“你今天下午有……”
```

当这个完整闭环成功时：

> 清华小助手 Agent V0.1 正式成立。

之后所有功能都是在这个可靠闭环之上的扩展。
