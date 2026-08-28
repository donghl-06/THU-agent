# 新版体育场馆预约系统 API 笔记（2026-08-28 逆向）

> 旧系统 50.tsinghua.edu.cn 已整体下线。新系统为正元智慧（UniFound）商用场馆预约产品，
> 部署在 `https://www.sports.tsinghua.edu.cn/venue/`，**公网直连，无需 webvpn**。
> 本文档是实现 `SportsClient` 的依据。探测脚本见 `scripts/debug-sports*.ts`。

## 登录链（全部验证通过）

```text
① GET  /venue/site/authcenter/toLoginPage?redirectUrl=<callback>&typeCode=
        → 302 链最终落在 id.tsinghua.edu.cn 直连登录表单
② GET  表单页 HTML → 抓取 <div id="sm2publicKey">04d0c9...</div>（元素文本）
③ POST https://id.tsinghua.edu.cn/do/off/ui/auth/login/check  (form-urlencoded)
        i_user=学号 & i_pass="04"+sm2.doEncrypt(密码, sm2publicKey)
        & fingerPrint=<THU_FINGERPRINT> & fingerGenPrint= & i_captcha=
        → 成功时响应含"登录成功。正在重定向到"，并带回调 <a href>
④ GET  回调链接（必须跟进！服务端在这一步才种会话）
        → 链终点：https://www.sports.tsinghua.edu.cn/venue/index.html?uniToken=<hex>
⑤ POST /venue/site/cas/token  {platForm:"CAS", client:"PC", token: uniToken}
        → data.token（JWT）+ data.refreshToken
⑥ 之后所有 API：请求头 token: <data.token> + 签名 query 参数
```

- 链路**不需要**先做库的 webvpn 登录（debug-sports14.ts 验证）。
- 需要携带 Cookie 跟跳转（①③④），直接用 `@thu-info/lib` 补丁后的
  `uFetch` / `getRedirectUrl`（它们维护全局 cookie jar，与 ThuClient 共享无冲突——
  体育站拿到 token 后不再依赖 cookie）。
- 直连 ID 登录**未触发 2FA**（信任设备 fingerprint 生效）。若触发则抛错提示。

## 请求签名（每个 API 调用都要）

```text
query: appId=1497016617475903488 & nonce=<32位随机> & timeStamp=<毫秒> & sign=<md5>
sign = MD5("appId=<appId>&nonce=<nonce>&timeStamp=<timeStamp>&key=57325972627c40bd8c77296d39293705")
```

key 是原厂前端混淆硬编码（chunk.chunk-common 模块 bac8/df43），所有学校部署通用。

## 响应加密（兜底）

个别端点返回密文字符串而非 JSON：AES-256-CBC，key 同上，iv=16 个 "0"，
Iso10126 填充，base64。当前用到的端点都是明文 JSON，先保留兜底。

## 数据接口

| 端点 | 方法 | 参数 | 说明 |
|---|---|---|---|
| `/venue/site/api/site/scene/list` | GET | — | 全部预约场景（33 个）：`[{uuid, sceneName, relatedType:"DEV", ...}]` |
| `/venue/site/api/site/scene/detail` | GET | `uuid` | 场景详情（`id, sceneName, status, ...`） |
| `/venue/site/api/site/siteType` | GET | `sceneUuid` | 场地类型筛选项 `[{label, value}]`（全校通用表） |
| `/venue/site/api/reserve/current/page` | POST | 见下 | 某场景某天的场地列表 |
| `/venue/site/api/reserve/current/detail` | POST | 见下 | 单块场地的分时详情 |

**current/page** body:

```json
{
  "sceneUuid": "<场景uuid>",
  "reserveDate": "YYYY-MM-DD",
  "pageNum": 1, "pageSize": 50,
  "resvKind": "CURRENT_RESERVE",
  "siteKindId": "<可选，siteType 的 value>",
  "searchValue": "<可选>"
}
```

返回 `{count, data: [Field]}`。Field 关键字段：

- `uuid` / `siteName`（如 "羽01"）/ `siteType`（"DEV"）/ `kindName`（"羽毛球"）
- `siteLocation.location`（"清华/气膜馆/1F/气膜馆羽毛球场"）
- `openRule.fullOpenTime`（按 MON..SUN 的开放时段）
- `reserveStatus`: `{reserveStatus: "Y"|"N", reserveStatusReason, availableRange: [{startTime, endTime}]}`
- `reserveRule` / `formRuleVo` / `feeRuleVo`（开放时非空，含预约规则/表单/费用）

**current/detail** body:

```json
{
  "sceneUuid": "<场景uuid>",
  "reserveDate": "YYYY-MM-DD",
  "siteUuid": "<场地uuid>", "siteType": "DEV",
  "reserveStartDate": "YYYY-MM-DD",
  "reserveEndDate": "YYYY-MM-DD"
}
```

返回单块场地详情，结构同上，`reserveStatus.availableRange` 是**可约时间段**。

## 可约性判定

`reserveStatus.reserveStatus === "Y"` 且 `availableRange` 非空 → 可约。
`"N"` 时 `reserveStatusReason` 给出原因（如"未开放"、"申请表单信息缺失"）。

## 当前状态（2026-08-28，暑假）

全部 33 个场景、未来 4 天所有场地均返回 `N(申请表单信息缺失)`，
`formRuleVo`/`reserveRule` 为 null——**判断为暑期真实闭馆**（秋季学期开放安排见
"清华体育"公众号）。Skill 实现需优雅处理该状态（返回 note 而非报错）。
学期开始场馆开放后，`availableRange` 会给出真实可约时段。
