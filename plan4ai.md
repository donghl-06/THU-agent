# THU Assistant Agent — Project Context & AI Coding Instructions

你正在协助开发一个名为 **THU Assistant Agent（清华小助手 Agent）** 的项目。

在进行任何代码修改之前，请首先理解以下项目目标、架构原则和当前开发阶段。

---

# 1. 项目目标

本项目目标是构建一个面向清华大学校园生活场景的 LLM Agent。

Agent 应允许用户通过自然语言完成校园信息查询，并能够在必要时自主组合多个校园能力。

例如：

```text
用户：
“我今晚没课的话想打羽毛球，帮我看看什么时候合适。”

Agent：
1. 查询用户当天课表；
2. 判断晚间空闲时间；
3. 查询体育场馆资源；
4. 综合时间与场地情况；
5. 返回建议。
```

因此，本项目不是简单的 FAQ Bot，也不是把已有 App 换成聊天界面。

核心目标是：

```text
Natural Language
        ↓
LLM Reasoning
        ↓
Skill Selection
        ↓
Campus Service
        ↓
Multi-Skill Reasoning
        ↓
Useful Answer / Action
```

---

# 2. 参考项目

核心参考仓库：

```text
https://github.com/thu-info-community/thu-info-app
```

这是一个用于聚合清华校园信息的 React Native 应用。

其 UI 代码不是本项目最重要的部分。

本项目最重要的已有基础是：

```text
packages/thu-info-lib/
```

其中的：

```text
@thu-info/lib
```

是一个 program-friendly 的清华校园服务接口库。

它已经包含大量清华校园能力，因此本项目原则上：

> 不重新实现清华 Web Portal 请求，而是复用 `@thu-info/lib`。

已有能力包括但不限于：

```text
User information

Schedule

Classroom

Library

Library seats

Library rooms

News

Campus card

Dormitory

Electricity

Network

Sports reservation

Course registration

Teaching assessment
```

以及其他校园服务。

---

# 3. 系统总体架构

目标架构：

```text
                    User
                     │
                     ▼
              DeepSeek Model
                     │
          reasoning / tool selection
                     │
                     ▼
              DeepSeek Harness
                     │
          tool registry / session
          permission / retry
          context / confirmation
                     │
                     ▼
                THU Skills
                     │
                     ▼
                 ThuClient
                     │
                     ▼
               @thu-info/lib
                     │
                     ▼
             Tsinghua Services
```

请严格维持各层职责边界。

---

# 4. 各层职责

## @thu-info/lib

职责：

```text
Actual access to Tsinghua services
```

不要在 Agent 层重复实现已有 HTTP 请求、页面解析或认证逻辑，除非现有 library 明确缺失该能力。

---

## ThuClient

职责：

```text
统一包装 @thu-info/lib
```

应负责：

```text
InfoHelper lifecycle
authentication
session
cookie / credential handling
retry
timeout
error normalization
API result normalization
```

Skill 不应该自己处理完整认证逻辑。

---

## Skill

Skill 是 Agent 可以调用的原子校园能力。

例如：

```text
get_schedule

get_classroom_state

get_campus_card_info

get_library_seats

get_sports_resources
```

Skill 的职责应该非常有限：

```text
validate input
        ↓
call ThuClient
        ↓
normalize output
        ↓
return SkillResult
```

Skill 不负责：

```text
LLM reasoning
planning
conversation state
prompt construction
tool routing
agent loop
```

---

# 5. Skill 设计原则

所有 Skill 应尽量遵循统一结构。

建议接口：

```typescript
interface Skill {
    name: string;
    description: string;
    inputSchema: object;
    execute(input: unknown): Promise<SkillResult>;
}
```

统一返回格式：

```typescript
interface SkillResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}
```

Skill 必须具备：

```text
clear name

clear description

clear input schema

stable structured output

independent executability

independent testability
```

禁止把复杂业务目标直接作为 Skill，例如：

```text
BAD:

solve_student_problem

plan_my_day

help_me_choose_course
```

应该抽取基础能力：

```text
GOOD:

get_schedule

search_courses

get_selected_courses

get_sports_resources
```

复杂任务交给 LLM 通过多个 Skill 组合完成。

---

# 6. 当前第一批 Skills

第一阶段不要实现所有校园 API。

只实现以下 Read Skills：

```text
1. get_schedule

2. get_classroom_state

3. get_campus_card_info

4. get_library_seats

5. get_sports_resources
```

优先顺序：

```text
get_schedule
    ↓
get_campus_card_info
    ↓
get_classroom_state
    ↓
get_library_seats
    ↓
get_sports_resources
```

---

# 7. 当前第一目标

当前项目最重要的 Milestone 是：

```text
成功运行 @thu-info/lib

↓

成功登录

↓

成功调用 getSchedule()

↓

建立 ThuClient

↓

实现 get_schedule Skill

↓

独立测试 Skill

↓

返回稳定 JSON
```

此阶段：

> 不要急于实现 DeepSeek Harness。

在 Skill 层没有稳定之前，不引入额外 Agent 复杂度。

---

# 8. 推荐项目结构

推荐逐步整理为：

```text
thu-assistant/
│
├── src/
│
│   ├── client/
│   │   ├── ThuClient.ts
│   │   ├── auth.ts
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
│   ├── harness/
│   │
│   ├── config/
│   │
│   └── index.ts
│
├── tests/
│
├── eval/
│
├── .env.example
│
└── package.json
```

不要为了符合这个结构而一次进行大规模重构。

应随着项目推进逐步建立。

---

# 9. 测试原则

所有 Skill 必须可以脱离：

```text
DeepSeek
Harness
Chat UI
```

独立执行。

例如：

```typescript
const result = await getScheduleSkill.execute({
    date: "2026-08-28"
});
```

只有当 Skill 本身稳定后，才允许接入 Agent。

调试问题时遵循：

```text
Skill test fails

→ investigate Skill / ThuClient / @thu-info/lib


Skill test passes
but Agent fails

→ investigate Harness / Tool Schema / Prompt / Model
```

不要把不同层的问题混在一起调试。

---

# 10. Harness 阶段

完成第一批稳定 Skills 后，再接 DeepSeek Harness。

第一版 Harness 只需要支持：

```text
Tool Registration

Tool Schema

DeepSeek Function Calling

Tool Execution

Tool Result Return

Agent Loop

Basic Session
```

不要过早实现：

```text
Multi-Agent

Complex Planner

Long-term Memory

RAG

Vector Database

Autonomous Code Mode

Complex Workflow Engine
```

除非实际需求明确证明需要。

---

# 11. Agent Loop

最基础流程应类似：

```text
User Message

↓

DeepSeek

↓

Does model request a tool?

├── No
│      ↓
│   Return answer
│
└── Yes
       ↓
    Validate tool call
       ↓
    Execute Skill
       ↓
    Return Skill Result to model
       ↓
    DeepSeek continues reasoning
```

目标首先是保证这个闭环可靠。

---

# 12. Read / Write Skill 安全边界

Skill 必须区分：

## Read Skills

例如：

```text
get_schedule

get_campus_card_info

get_library_seats

get_sports_resources
```

Agent 可以在合理情况下自主调用。

---

## Write / Action Skills

例如：

```text
book_library_seat

cancel_library_booking

make_sports_reservation

pay_sports_reservation

select_course

delete_course

recharge_campus_card

report_campus_card_loss
```

这些操作具有真实世界后果。

原则：

```text
Agent proposes action

↓

show exact intended action to user

↓

receive explicit confirmation

↓

Harness authorization

↓

execute Skill
```

不要让 LLM 仅凭自己的判断完成具有真实后果的校园操作。

---

# 13. Credential 安全

清华账号密码、Cookie、Session Token 等属于敏感数据。

开发时必须：

```text
use environment variables
or ignored local secret files
```

禁止：

```text
hard-code credentials

commit passwords

commit cookies

commit tokens

print sensitive information into logs
```

如果参考仓库测试需要 credential，也不要将真实 credential 提交到 Git。

---

# 14. 编码原则

开发时优先：

```text
simple

explicit

testable

modular

small changes
```

避免：

```text
premature abstraction

large rewrites

unnecessary frameworks

hidden side effects

duplicated authentication

duplicated API logic
```

当现有代码可复用时，优先复用。

---

# 15. 修改代码时的 AI 工作方式

每次收到开发任务时，请：

1. 先检查相关代码；
2. 确认当前实现；
3. 找到最小修改路径；
4. 简要说明准备修改什么；
5. 修改代码；
6. 运行相关测试或检查；
7. 检查 diff；
8. 总结修改结果。

不要在没有查看现有代码的情况下假设目录结构或 API。

不要因为预计未来可能需要某功能就提前实现。

---

# 16. 遇到不确定 API 时

如果你不知道 `@thu-info/lib` 某个方法：

```text
input type

return type

authentication requirement

side effect
```

请优先检查：

```text
packages/thu-info-lib/src/

packages/thu-info-lib/src/lib/

packages/thu-info-lib/src/models/

existing tests

demo.js
```

不要猜测 API。

---

# 17. 当前开发哲学

本项目采用：

> Bottom-up Agent Development

即：

```text
Campus API

↓

ThuClient

↓

Skills

↓

Skill Tests

↓

DeepSeek Harness

↓

Single-Skill Agent

↓

Multi-Skill Agent

↓

Write Skills

↓

Evaluation
```

不要反过来先搭一个复杂 Agent 框架再寻找功能填进去。

---

# 18. 项目成功标准

本项目的第一个真正 Agent Demo：

```text
User:

“我今天下午有什么课？”


DeepSeek:

decides to call get_schedule


Harness:

executes get_schedule


Skill:

calls ThuClient


ThuClient:

calls @thu-info/lib


Result:

real schedule data


DeepSeek:

returns a natural-language answer
```

第二个重要 Demo：

```text
User:

“我今晚没课的话想去打羽毛球，
帮我看看什么时候合适。”


Agent:

get_schedule

↓

reason about free time

↓

get_sports_resources

↓

combine results

↓

give recommendation
```

当第二个 Demo 能够稳定完成时，系统已经真正具有 Agent 特征，而不仅仅是 API Chatbot。

---

# 19. 当前任务优先级

除非用户明确要求改变方向，否则当前优先级始终是：

```text
P0
Run @thu-info/lib successfully

P1
Login successfully

P2
Run getSchedule successfully

P3
Create ThuClient

P4
Design Skill interface

P5
Implement get_schedule

P6
Test get_schedule independently

P7
Expand to five Read Skills

P8
Integrate DeepSeek Harness

P9
Build multi-Skill behavior
```

如果一个低优先级任务会显著扩大项目复杂度，请提醒用户，而不是默默加入。

---

# 20. 最重要的一句话

始终保持以下架构关系：

```text
@thu-info/lib
=
Tsinghua capability SDK


THU Skills
=
Agent-facing capability adapters


DeepSeek Harness
=
Agent runtime and orchestration


DeepSeek Model
=
reasoning and decision-making
```

任何实现都尽量不要破坏这一职责分离。
