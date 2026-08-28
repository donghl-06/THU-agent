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
header: token: <accessToken>
header: x-api-version: 2.0.0     ← 关键！缺失时服务端走旧版逻辑，
                                    所有场地返回 N(申请表单信息缺失)
query: appId=1497016617475903488 & nonce=<32位随机> & timeStamp=<毫秒> & sign=<md5>
sign = MD5("appId=<appId>&nonce=<nonce>&timeStamp=<timeStamp>&key=57325972627c40bd8c77296d39293705")
```

key 是原厂前端混淆硬编码（chunk.chunk-common 模块 bac8/df43），所有学校部署通用。

## 限流

服务端有频率限制，突发请求返回 `{"code":500,"message":"请求频繁，请稍后再试"}`。
SportsClient 对限流做线性退避重试（1.5s 起步，最多 3 次）；调用方应避免大规模并行
（多场景查询请串行）。

## 响应加密（兜底）

个别端点返回密文字符串而非 JSON：AES-256-CBC，key 同上，iv=16 个 "0"，
Iso10126 填充，base64。当前用到的端点都是明文 JSON，先保留兜底。

## 数据接口

| 端点 | 方法 | 参数 | 说明 |
|---|---|---|---|
| `/venue/site/api/site/scene/list` | GET | — | 全部预约场景（33 个）：`[{uuid, sceneName, relatedType:"DEV", ...}]` |
| `/venue/site/api/site/scene/detail` | GET | `uuid` | 场景详情（`id, sceneName, status, ...`） |
| `/venue/site/api/site/siteType` | GET | `sceneUuid` | 场地类型筛选项 `[{label, value}]`（全校通用表） |
| `/venue/site/api/site/choose` | GET | `sceneUuid, siteType, siteUuid` | 位置级联：CAMPUS→BUILDING→FLOOR→ROOM，逐级传上一级 uuid |
| `/venue/site/api/reserve/current/page` | POST | 见下 | 某场景某天的场地列表（**必须按房间维度查**） |
| `/venue/site/api/reserve/current/detail` | POST | 见下 | 单块场地的分时详情 |

**current/page** body（缺 classTypeEnum/classTypeUuid/sceneUseType 会返回空列表）：

```json
{
  "sceneUuid": "<场景uuid>",
  "resvKind": "CURRENT_RESERVE",
  "siteType": "DEV",
  "searchValue": "",
  "siteKindId": "",
  "classTypeEnum": "ROOM",
  "classTypeUuid": "<site/choose 级联到 ROOM 级的 uuid>",
  "reserveDate": "YYYY-MM-DD",
  "sceneUseType": "SPORT_GROUP",
  "pageSize": 999,
  "pageNum": 1
}
```

返回 `{count, data: [Field]}`。Field 关键字段：

- `uuid` / `siteName`（如 "羽01"）/ `siteType`（"DEV"）/ `kindName`（"羽毛球"）
- `siteLocation.location`（"清华/气膜馆/1F/气膜馆羽毛球场"）
- `reserveStatus`: `{reserveStatus: "Y"|"N", reserveStatusReason, availableRange: [{startTime, endTime}]}`
  —— `availableRange` 是**空闲可约时间段**（精确到分钟，如 "20:30-23:59"）
- `reserveRule.laterLineTime`: `{lowerRange:"08:00:00", upperRange:"23:59:59"}` —— 实际可约时间窗，
  `availableRange` 可能越出它（如空闲段从 00:00 开始），展示前需裁剪
- `reserveRule.timeInterval`（预约粒度，分钟）/ `limitValue`（限约次数）
- `formRuleVo` / `feeRuleVo`（预约表单/费用规则）

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

返回单块场地详情，结构同上。

## 可约性判定

`reserveStatus.reserveStatus === "Y"` 且 `availableRange ∩ laterLineTime` 非空 → 可约。
`"N"` 时 `reserveStatusReason` 给出原因（如"未开放"、"场次信息缺失"）。

## 排障史（2026-08-28）

初版实现所有场馆均返回 `N(申请表单信息缺失)`，疑似暑期闭馆——**是假象**。
用户确认浏览器端可正常预约后，逐字复刻浏览器请求做消融实验，定位根因：
**缺少 `x-api-version: 2.0.0` 请求头**（服务端按它区分新旧版 API 逻辑），
外加 `current/page` 必须带位置级联参数（`classTypeEnum=ROOM` + `classTypeUuid` +
`sceneUseType=SPORT_GROUP`）。修正后真实数据吻合（当晚 19 点查询，各馆只剩
22 点后的空闲段，周六白天全满）。
教训：对接无文档系统时，**尽早抓取浏览器真实请求做对照**，比纯静态分析快得多。
