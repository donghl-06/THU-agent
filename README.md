# THU Assistant Agent（清华小助手 Agent）

面向清华大学校园生活场景的 LLM Agent 项目（开发中）。

用户用自然语言描述需求（如"我今晚没课的话想打羽毛球，帮我看看什么时候合适"），
Agent 自主判断并组合多个校园能力（查课表 → 推理空闲时间 → 查体育场馆 → 综合建议），
而不是把已有 App 换成聊天界面。

> 详细架构原则见 [plan4ai.md](plan4ai.md)，阶段规划见 [plan4me.md](plan4me.md)，
> 新手向落地路线图见 [ROADMAP.md](ROADMAP.md)。

## 架构分层

```text
LLM（Kimi/GLM/DeepSeek，OpenAI 兼容协议）← 推理与决策
Harness             ← Agent 运行时：工具注册、Agent Loop（src/harness/）
THU Skills          ← Agent 可调用的原子能力（src/skills/）
ThuClient           ← 统一封装登录/会话/重试（src/client/）
SportsClient        ← 新版体育场馆系统客户端（src/client/sports/，独立链路）
@thu-info/lib       ← 清华校园服务 SDK（npm 依赖 + 本地补丁）
```

## 环境要求

- Windows + WSL2 Ubuntu（或任意 Linux/macOS）
- Node.js ≥ 22
- pnpm 10（`npm install -g pnpm`）
- 清华大学 Info 账号（用于登录校园服务）
- 任意 OpenAI 兼容的 LLM API Key（Kimi / GLM / DeepSeek 均可）

## 配置步骤

```bash
# 1. 克隆本仓库
git clone git@github.com:donghl-06/THU-agent.git
cd THU-agent

# 2. 安装依赖（会自动应用 patches/ 里对 @thu-info/lib 的补丁）
pnpm install

# 3. 配置凭证
cp .env.example .env
# 编辑 .env，填入：
#   THU_USERNAME    学号
#   THU_PASSWORD    密码
#   THU_FINGERPRINT 设备指纹（32 位 hex，可用以下命令生成）
node -e "console.log(require('crypto').randomUUID().replace(/-/g,''))"
#   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL  LLM 配置（Kimi 示例见 .env.example 注释）
```

## 和小助手对话（V0.1 里程碑 🎉）

```bash
pnpm agent   # 命令行 Agent：注册全部 5 个查询技能，模型自主决定调哪个
```

试试这些问法：

```text
我今天下午有什么课？
现在图书馆还有座位吗？
今晚气膜馆羽毛球还有场吗？
```

## 供任意 AI Agent 调用

仓库内置了一个遵循 Agent Skills 目录结构的项目级 Skill：
`.agents/skills/thu-agent/SKILL.md`。兼容 Agent Skills 且能运行本地命令的
AI Agent 可以自动发现它，并通过机器可读 CLI 使用 `createAllSkills()` 中装配的
全部校园能力，不需要接入本项目自己的 LLM。

也可以直接检查这层接口：

```bash
pnpm --silent skill list
pnpm --silent skill describe get_schedule
pnpm --silent skill call get_schedule --input '{"date":"2026-08-31"}'
```

输出统一为 JSON。查询调用只需要 `THU_*` 凭证，不需要 `LLM_*` 配置。
所有 `requiresConfirmation: true` 的预约、取消、充值和支付类操作默认拒绝执行；
外部 Agent 必须先向用户展示完整操作参数并取得本次明确同意，之后才能为该次调用
附加 `--confirmed-by-user`。确认不能跨调用复用，失败或结果不明确时也不能自动重试。

⚠️ `.env` 已在 `.gitignore` 中，**绝不要**把真实凭证写进 `.env.example` 或任何会被提交的文件。

## 验证

按顺序运行（首次登录会要求二次认证，通过后设备被信任，之后不再需要）：

```bash
pnpm step1   # InfoHelper 实例化（不联网）
pnpm step2   # 真实登录 + 获取用户信息
pnpm step3   # 获取真实课表
```

其他命令：

```bash
pnpm agent       # 命令行对话 Agent（需要 LLM_* 配置）
pnpm dev         # 项目入口（当前为占位）
pnpm test        # 全部测试（Skill + Harness 单测 + 真实链路集成测试）
pnpm typecheck   # TypeScript 类型检查
```

## 注意事项

- **openssl.cnf**：清华服务器使用旧版 TLS 重协商，Node 17+ 默认拒绝连接，
  因此涉及网络请求的脚本都需要 `OPENSSL_CONF` 环境变量（已内置在 package.json 脚本中）。
- **patches/**：npm 版 `@thu-info/lib@3.15.2` 在 Node 环境存在重定向链 Cookie 丢失、
  重定向次数上限不足等问题，上游仓库（3.16.4）已修复但未发布。
  本仓库通过 pnpm patch 移植了这些修复，重装依赖时自动应用。
- **设备信任**：登录脚本会向你的清华账号登记一个名为 `thu-assistant-dev` 的
  信任设备（官方 App 同款机制），可随时到 <https://id.tsinghua.edu.cn/> 的
  「多因子认证」管理页面删除。
- **调试脚本**：`pnpm debug:csrf` / `pnpm debug:roam` / `pnpm debug:chain`
  用于诊断登录/漫游链路问题。
- **体育场馆**：旧系统 50.tsinghua.edu.cn 已于 2026-08 整体下线。
  本项目直接对接新系统 <https://www.sports.tsinghua.edu.cn/venue/>（公网直连，
  无需 webvpn），登录链路与接口逆向笔记见 [docs/sports-api-notes.md](docs/sports-api-notes.md)。
  注意新系统 API 必须带 `x-api-version: 2.0.0` 请求头，且按房间维度查询，
  否则会拿到"场馆未开放"的假数据。
- **参考仓库**：开发参考 <https://github.com/thu-info-community/thu-info-app>
  （克隆到 `reference/` 目录，只读，不进 git）。

## 许可

- 本项目目前为个人学习项目，暂未指定开源许可。
- 核心依赖 [`@thu-info/lib`](https://www.npmjs.com/package/@thu-info/lib)
  采用 **Business Source License 1.1 (BSL)**，本项目对其的使用与补丁
  （`patches/` 目录）受其约束，如需分发请先阅读该许可条款。
- 清华账号凭证属于敏感个人信息，本项目代码不包含、也不要求提交任何真实凭证。
