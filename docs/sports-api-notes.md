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

## 限流与维护

- **限流**：服务端有频率限制，突发请求返回 `{"code":500,"message":"请求频繁，请稍后再试"}`。
  SportsClient 对限流做线性退避重试（1.5s 起步，最多 3 次）；调用方应避免大规模并行
  （多场景查询请串行）。
- **每日维护**：每天凌晨 01:00–02:00 系统维护，期间 SSO 入口不跳转（返回 200 +
  `{"code":500,"message":"系统维护中, 维护时间01:00 - 02:00"}`），API 同样返回该公告，
  部分连接直接断开。SportsClient 识别后抛 `ThuError("MAINTENANCE", …)`，
  错误信息里带维护时间段（2026-08-29 实测）。
- 网络层失败（TIMEOUT/NETWORK_ERROR）同样退避重试（全场景查询百余请求，单次抖动不应整体失败）。

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
| `/venue/site/system/login/getLoginUser` | GET | — | 当前登录用户 `{id, nickName, account, ...}`（预约的 resvMember 需要 id） |
| `/venue/site/api/reserve/addReserve` | POST | 见下 | 下单预约（写操作） |
| `/venue/site/resv/order/check` | POST | `{resvUuidList, userId}` | 下单后检查是否生成待支付订单 `{orderGenerated, freeOrder}` |
| `/venue/site/api/reserve/reserveRecord` | POST | — | 我的预约记录 |
| `/venue/site/api/reserve/cancelReserve` | POST | — | 取消预约（未实装） |

**addReserve** body（单场地单场次，逆向自前端 chunk-0e504f6d 的 addReserve/submit 方法）：

```json
{
  "sceneUuid": "<场景uuid>",
  "sceneUseType": "SPORT_GROUP",
  "siteUuid": "<场地uuid>",
  "siteType": "DEV",
  "reserveTime": [{"sessionDetailUuid": "<场次uuid>",
                   "reserveTime": {"startTime": "YYYY-MM-DD HH:mm:00", "endTime": "YYYY-MM-DD HH:mm:00"}}],
  "siteSessionReserve": [<同上结构>],
  "resvMember": ["<getLoginUser 的 id>"],
  "resvKind": "CURRENT_RESERVE",
  "payType": "PAY_ONLINE",
  "purchaseUuid": "",
  "formParam": {},
  "captcha": ""
}
```

- 成功返回 `data.resvIds`（数组）；多场地用 `addMultiReserve` + `multiSiteSessionReserve`（未实装）。
- **账号存在未支付订单时（orderStatus=1），一切新预约都会被拒**：
  "您有未支付的订单，请支付完成后，再进行预约。"（2026-08-29 实测）。
  排查入口：`POST /api/reserve/reserveRecord` 翻页找 orderStatus=1 的记录。
- 下单后必须 `orderCheck`：`orderGenerated && !freeOrder` = 生成了待支付订单，
  需到官方网页/App 完成支付，超时订单取消；`freeOrder` = 免费场次直接成功。
- `payType` 枚举：`PAY_ONLINE`（线上）/ `PAY_OFFLINE`（线下，不产生线上扣款）/ `PAY_CARD`（次卡，需 purchaseUuid）。
  场次 `sessionVo[].userFeeDetails.payType` 是数字码，前端映射 `{1:线上, 2:线下, 3:线上}`
  （chunk-0e504f6d）——但它只是**前端预选默认值，不是限制**：用户在前端确认
  任何项目任何场次都能选线上或线下。Skill 规则：付费场次由用户选择后传入，
  用户没选就返回 PAY_TYPE_REQUIRED 让模型去问；免费场次不问。
  （2026-08-29 曾把数字码误判为强制限制：硬传 PAY_OFFLINE 被 06:00 场拒单
  "当前开始时间不支持线下支付"，当时以为是时段限制，实为该场默认线上。）
- `formParam`：`formId` = 场地 `formRuleVo.formUuid`；**`deployUuid` 必须再查
  `GET /workflow/process/brief/{formUuid}` 拿**（前端 onChangReserve 就是这么做的），
  只填 formId 不填 deployUuid 会被拒："表单信息不能为空"（2026-08-29 实测）。
  场地无表单时两者都传 ""。
- **验证码**：提交阶段需要滑块拼图验证码（AJ-Captcha blockPuzzle；
  `GET /api/reserve/enableValidCode` 实测返回配置项 `sysKey=RESV_CODE, sysValue="1"` = 开启）。
  链：`POST /system/captcha/drag/get`（body: `{captchaType:"blockPuzzle", clientUid, ts}`，
  响应外壳是 `{success, repData}` 而非常规 `{code, data}`，
  repData 含 `secretKey/token/originalImageBase64/jigsawImageBase64`）→
  求缺口 X → `POST /system/captcha/drag/check`（`pointJson` = AES-128-ECB-PKCS7
  加密 `{"x":X,"y":5}`，key=secretKey，base64）→
  **check 通过时 repData.token 会下发新 token**（真实抓包确认，旧项目 captcha.py
  Step 4），addReserve 的 `captcha` 字段 = 同法加密 `新token + "---" + {"x":X,"y":5}`。
  SportsClient 的 checkDragCaptcha 通过时会直接更新 cap.token。
  drag/check 失败码实测（2026-08-29）：`6111` = 位置不对，token 仍有效可继续试下一候选；
  `6110` = 验证码已失效（试错次数限制约 2-3 次/张），必须重新 drag/get 换新图。
  识别策略因此是"候选逐个试 + 整链最多换 3 张图"（bookSportsField CAPTCHA_MAX_ATTEMPTS）。
  SportsClient 已实现 getDragCaptcha/checkDragCaptcha/buildCaptchaValue；
  X 的求解走超级鹰打码平台（src/client/captcha/chaojiying.ts，移植自旧项目的
  ChaojiyingSolver：codetype 9900 返回候选缺口矩形，按"矩形高度≈拼图块高度"排序，
  逐个 drag/check 验证；.env 配 CJY_USER/CJY_PASSWORD/CJY_SOFT_ID，单次约 0.01 元）。

### 与真实抓包的差异修正（2026-08-29，来自用户旧项目 auto--badminton-booking-system）

该项目对同一系统做过浏览器抓包并有实战成功记录，两处与我们从前端代码读出的结构不同，
**以抓包为准**（已应用到 SportsClient.bookSession）：

1. `sessionDetailUuid` 只在 `siteSessionReserve` 里；`reserveTime` 只带 `{startTime, endTime}`。
2. 实战用 `payType: "PAY_OFFLINE"`（推荐）——不动线上资金，到场支付。

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
- **`sessionVo`: 场次表——真正的可约单元**（见下方"可约性判定"）：
  `[{beginTime:"06:00", endTime:"08:00", reserveStatus:{reserveStatus:"Y"|"N", reserveStatusReason}, userFeeDetails:{chargingUnitPrice: 4000(分)}}]`
- `reserveStatus`: `{reserveStatus: "Y"|"N", reserveStatusReason, availableRange: [{startTime, endTime}]}`
  —— ⚠️ `availableRange` **不是**"开放可约时间段"，而是"未被任何场次/预约覆盖的空白时间段"
  （2026-08-29 实锤，见排障史）。打烊后（22:00-23:59）没有场次，也会显示成"空闲"，**不可用于可约判定**
- `supportPeriod`: "Y" 表示该场地支持自由时段预约（此时无 sessionVo，才参考 availableRange）
- `reserveRule.laterLineTime`: `{lowerRange:"08:00:00", upperRange:"23:59:59"}` —— 预约时间窗限制，
  仅在自由时段回退路径用来裁剪 availableRange
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

**以场次表 `sessionVo` 为准**：`session.available === true`（即 `reserveStatus.reserveStatus === "Y"`）
的场次才是真的可约；`reserveStatusReason` 给出不可约原因
（"当前场次预约人数已满" / "场次已被锁场"）。
仅当场地 `supportPeriod === "Y"`（自由时段制、无场次表）时，才回退用
`availableRange ∩ laterLineTime` 判定。

## 排障史（2026-08-28）

初版实现所有场馆均返回 `N(申请表单信息缺失)`，疑似暑期闭馆——**是假象**。
用户确认浏览器端可正常预约后，逐字复刻浏览器请求做消融实验，定位根因：
**缺少 `x-api-version: 2.0.0` 请求头**（服务端按它区分新旧版 API 逻辑），
外加 `current/page` 必须带位置级联参数（`classTypeEnum=ROOM` + `classTypeUuid` +
`sceneUseType=SPORT_GROUP`）。修正后真实数据吻合（当晚 19 点查询，各馆只剩
22 点后的空闲段，周六白天全满）。
教训：对接无文档系统时，**尽早抓取浏览器真实请求做对照**，比纯静态分析快得多。

## 排障史（2026-08-29，第二次语义误判）

上一版把场地级 `reserveStatus.availableRange` 当成"开放可约时间段"，
导致 Agent 报告"22:00-24:00 12 片全空可约"——**用户实锤该时段场馆根本不开放**。
dump 原始 JSON 后真相大白：气膜馆每天只有 06:00–22:00 的 8 个场次（`sessionVo`），
`availableRange` 是这些场次的**补集**（00:25-06:00、22:00-23:59 正是"没有任何场次"的空白段），
场地级 `reserveStatus: "Y"` 只表示"存在空白段"，与可约性无关。
修复：可约判定改为以 `sessionVo` 场次为单位；`availableRange` 仅在
`supportPeriod === "Y"` 的自由时段场地作回退。
教训：**聚合/补集类字段要警惕"空白≠可约"**，语义必须以"浏览器实际能点什么"为准。

## 排障史（2026-09-02，第四次：错别字场景名 + 游泳馆模式错配）

用户报：查今晚体育场馆提示"不在提前预约范围内"，实际乒乓球有空位、羽毛球全满。

**游泳馆"查不到任何数据"的真正根因（用户抓包实锤）：`sceneUseType` 模式错配。**
球类场馆是团体场地模式（`SPORT_GROUP`，按片预订），游泳馆是个人票务模式
（`SPORT_PERSON`，按人次订场次）——用 SPORT_GROUP 查游泳馆**恒定返回空壳**
（服务端在团体视角下该馆无可售场地），与限流无关，8-31"有位报满"与 9-02
"查不到数据"是同一根因。平台前端的 /swim 专页里硬编码 SPORT_PERSON，
所以平台永远有数据。修复：getFieldPage 两轮查询——先 SPORT_GROUP，
全空时用 SPORT_PERSON 兜底重查（球类第一轮即命中，不多花请求）。
响应侧 PERSON 模式结构同构（sessionVo/reserveStatus/userFeeDetails），
parseSessions 无需改动；"全场"作为一个整体 site，allowUserNum=300、
resvUserNum 为已约人数。带 devKindUuid 反而会按类型过滤（"全场"uuid 各场景
不同，拿全局表的会过滤成空）——**不要带**。

**发现 1（用户可见 bug 的根因）：平台场景名错别字。** 场景列表里乒乓球写作
"北体**兵**乓球"（兵≠乒），skill 的严格 `sceneName.includes("乒乓球")` 永远匹配失败，
返回 INVALID_INPUT 并附 33 个场景名；上层模型对失败**编造**了"不在提前预约范围内"。
真实数据一直都在（当晚乒2/3/4/7 等 12 片 17:00-19:00 可约）。
修复：新增 `src/skills/sports/sceneMatch.ts`——精确子串优先，无精确命中时按
滑动窗口编辑距离 ≤1 模糊匹配（查询 skill 直接采用；预约 skill 因写操作要求唯一，
模糊命中也必须唯一）。"不在提前预约范围内"并非服务端 reserveStatusReason 原文。

**发现 2（修正 9-01 的错误记录）：** 9-01 曾推断"8-31 晚平台重排数据、ROOM uuid
全部变化"——证据不足，系诊断笔误：`0fdca206...` 一直是**游泳馆**的 ROOM uuid
（从未变化），当时被错标成气膜馆的才得出"重排"结论。正确事实：气膜馆羽毛球场
当前 ROOM uuid 为 1865781826241564673；跨场景混用 uuid 查询必然得到空壳。
教训：**探针不要硬编码 uuid，且给硬编码值做注释前先核对它属于哪个场景**；
昨晚"全场景空壳"的真因是游泳馆模式错配（见上）叠加球类查询的间歇性空壳（见下）。

**发现 3（与用户旧仓库 auto--badminton-booking-system 对照）：**
参考实现的 current/page 带 `devKindUuid`（运动类型 uuid，来自
`GET /api/site/siteType?sceneUuid=`），实测**非必需**（不带同样返回全量）；
其位置级联用 `GET /api/site/chooseByType?sceneUuid=&siteType=BUILDING|ROOM`
（两步替代我们的四级 choose），可作为进一步降低请求数的备选，暂不切换。

**遗留观察：间歇性空壳。** 18:35 实时级联查询返回 0 场地，18:40 同样请求返回
12 条——短窗压制行为仍在（高频请求后几分钟内的查询可能为空），机制未完全定位。
诊断时若连续得到空壳，先静置几分钟再复核，避免把自己的诊断流量当成故障证据。

## 排障史（2026-08-31，第三次误报："有位报满"）

用户实锤：陈明游泳馆当晚 20:00-21:00 / 21:30-22:30 有空位，Agent 却回答"满了"。
排查发现 `current/page` 对**所有场景**（含此前一直正常的气膜馆）、**所有日期**
（含次日）均返回 `{code:0, data:[], count:0}`——表面"请求成功"的空壳。
曾逐一排除：位置级联（四层完好）、classTypeEnum 按层级变体（CAMPUS/BUILDING/FLOOR/ROOM）、
siteType 参数变体、custom 系列端点、sceneUseType 数字值、签名/版本头/baseURL
（对照 SPA chunk 静态分析均一致）。

**当晚 20:40 用户在 Web UI 正常查到羽毛球次日数据，而同一时段诊断探针全部空壳/报错**，
由此确认服务端状态与请求频率/时点强相关。当晚实测到限流/故障的两档表现：
轻档 = 所有查询返回"成功 + 空数据"；重档 = `site/choose` 直接报"数据不存在"。
静置 4 分钟、10 分钟、31 分钟后单发探测均未恢复——**惩罚窗口远大于半小时**，
或叠加了开学前夜（8/31→9/1）服务端场地数据重排。两种候选解释不互斥：

- A 限流：白天诊断探针（全场景扫描，每次百余请求）触发账号级滚动窗口惩罚，
  也殃及了同账号同时段的 Agent 正式查询（20:00 的"满了"很可能是这样来的）。
- B 服务端数据迁移：`scene/list` 正常而 `site/choose` "数据不存在"，符合迁移中形态。
  判别法：平台网页同一后端，若网页同样查不到即为 B（或 B+A 叠加）。

当日落地的防护修复（不管 A/B 哪个为真都正确）：

1. `listRooms` 位置级联进程内缓存（场景房间结构天级不变），每次场地查询省 4+N 个请求；
2. `SportsClient.api()` 全局最小间隔节流（300ms 串行闸），摊平瞬时并发；
3. 限流退避基础 1.5s→4s；
4. skill 禁止省略 resourceName 的全场景扫描（33 场景一次几百请求必触发限流），
   inputSchema 将 resourceName 设为必填；
5. 多场景同时查不到数据时，note 明确提示"大概率触发限流，建议 1-2 分钟后重试"。

已修复的确定性问题：skill 层曾把 `fields.length === 0`（查不到任何场地）
与"场次已全部订满或锁场"混为一谈——**"查不到数据"和"确认订满"是两回事**，
前者现在如实回报"未查到任何场地数据，请以体育平台页面为准"。
教训：**接口返回"成功 + 空数据"时，不能为它编造一个确定的业务解释**；
诊断时也须警惕自己的探针读错字段（本次曾误读 `rows` vs `data` 而空欢喜）、
警惕**自己的诊断流量成为故障源**（探针与业务查询共用同一账号，宜控制节奏）、
以及**在机制未证实前用单一假设收窄结论**（本次"端点整体失效"结论被用户实测推翻）。
