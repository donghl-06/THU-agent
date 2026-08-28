# THU Assistant Agent（清华小助手 Agent）

面向清华大学校园生活场景的 LLM Agent 项目（开发中）。

用户用自然语言描述需求（如"我今晚没课的话想打羽毛球，帮我看看什么时候合适"），
Agent 自主判断并组合多个校园能力（查课表 → 推理空闲时间 → 查体育场馆 → 综合建议），
而不是把已有 App 换成聊天界面。

> 详细架构原则见 [plan4ai.md](plan4ai.md)，阶段规划见 [plan4me.md](plan4me.md)，
> 新手向落地路线图见 [ROADMAP.md](ROADMAP.md)。

## 架构分层

```text
DeepSeek Model      ← 推理与决策（最后接入）
DeepSeek Harness    ← Agent 运行时（src/harness/，阶段 C）
THU Skills          ← Agent 可调用的原子能力（src/skills/）
ThuClient           ← 统一封装登录/会话/重试（src/client/）
@thu-info/lib       ← 清华校园服务 SDK（npm 依赖 + 本地补丁）
```

## 环境要求

- Windows + WSL2 Ubuntu（或任意 Linux/macOS）
- Node.js ≥ 22
- pnpm 10（`npm install -g pnpm`）
- 清华大学 Info 账号（用于登录校园服务）
- DeepSeek API Key（阶段 C 才需要）

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
```

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
pnpm dev         # 项目入口（当前为占位）
pnpm test        # Skill 独立测试（vitest）
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
- **参考仓库**：开发参考 <https://github.com/thu-info-community/thu-info-app>
  （克隆到 `reference/` 目录，只读，不进 git）。

## 许可

- 本项目目前为个人学习项目，暂未指定开源许可。
- 核心依赖 [`@thu-info/lib`](https://www.npmjs.com/package/@thu-info/lib)
  采用 **Business Source License 1.1 (BSL)**，本项目对其的使用与补丁
  （`patches/` 目录）受其约束，如需分发请先阅读该许可条款。
- 清华账号凭证属于敏感个人信息，本项目代码不包含、也不要求提交任何真实凭证。
