# 金蝶 K3Cloud 查询与凭证推送参数

> 记录日期：2026-07-28
>
> 依据：`finweb` 当前金蝶配置、官方 Python SDK 8.2.0、查询服务和凭证推送服务
>
> 目标：供 Auto Voucher 连接器和后续 MCP Tool Schema 共用
>
> 边界：只查询和保存凭证草稿，不提交、审核、反审核、删除或过账

## 1. 认证参数

Auto Voucher 使用与 `finweb` 一致的金蝶 API 签名认证，不再使用
`ValidateUser(accountId, username, password)`。

| Auto Voucher 配置 | finweb / SDK 字段 | 必填 | 存储位置 | 用途 |
|---|---|---:|---|---|
| `serverUrl` | `server_url` / `X-KDApi-ServerUrl` | 是 | 本地业务配置 | K3Cloud WebAPI 根地址 |
| `acctId` | `acct_id` / `X-KDApi-AcctID` | 是 | 本地业务配置 | API 数据中心/账套 ID |
| `username` | `username` / `X-KDApi-UserName` | 是 | 本地业务配置 | 专用 API 用户 |
| `appId` | `app_id` / `X-KDApi-AppID` | 是 | 本地业务配置 | 第三方应用 ID |
| `app_secret` | `app_secret` / `X-KDApi-AppSec` | 是 | 操作系统密钥库 | 第三方应用密钥 |
| `orgNum` | `org_num` / `X-KDApi-OrgNum` | 否 | 本地业务配置 | 登录组织编码；无通用默认值，按目标账套确认 |
| `localeId` | `lcid` / `X-KDApi-LCID` | 否 | 本地业务配置 | 语言，默认 `2052` |
| `connectTimeout` | `connect_timeout` | 否 | 本地业务配置 | 连接超时，默认 `120` 秒 |
| `requestTimeout` | `request_timeout` | 否 | 本地业务配置 | 请求超时，默认 `120` 秒 |
| `ledger` | `kingdee_acct_id` | 推送必填 | 本地业务配置 | 凭证账簿 `FAccountBookID.FNumber` |

`acctId` 与 `ledger` 不是同一个值：

- `acctId` 用于 API 签名认证。
- `ledger` 是凭证写入的账簿编号 `FNumber`。

官方 SDK 根据以上配置生成 `X-Api-*`、`X-Kd-Appkey`、
`X-Kd-Appdata` 和 `X-Kd-Signature` 请求头。AppSecret 不进入业务数据库、
诊断上下文或工具返回值。

## 2. 连接探测

连接探测必须执行真实只读请求：

```json
{
  "FormId": "BD_AccountBook",
  "FieldKeys": "FBOOKID,FNumber,FName",
  "FilterString": "",
  "OrderString": "",
  "TopRowCount": 1,
  "StartRow": 0,
  "Limit": 1
}
```

调用：`ExecuteBillQuery`。

通过标准：

1. SDK 签名请求成功；
2. 返回可解析的 JSON 数组；
3. 不要求一定有数据，但不能返回认证、网络、许可或 FormId 权限错误。

## 3. 通用查询参数

`ExecuteBillQuery` 的统一请求体：

```json
{
  "FormId": "目标表单",
  "FieldKeys": "逗号分隔字段",
  "FilterString": "字符串或金蝶数组过滤器",
  "OrderString": "",
  "TopRowCount": 0,
  "StartRow": 0,
  "Limit": 2000
}
```

Auto Voucher 单次查询上限为 `10000`。面向 MCP 时不开放任意 FormId，
只允许下表以及连接器配置中已经审核的只读模型。

## 4. 主数据查询

| 类型 | FormId | 主要字段 | finweb 过滤规则 |
|---|---|---|---|
| 公司/组织 | `ORG_Organizations` | `FORGID,FNumber,FName,FDescription,FDocumentStatus,FCreateDate,FModifyDate` | 无默认过滤 |
| 科目 | `BD_Account` | `FACCTID,FNumber,FName,FISDETAIL,FCreateOrgId,FUseOrgId,FDescription,FLevel,FDC,FFullName,FGroupID` | 明细科目；当前 finweb 还使用固定组织 ID 和银行科目前缀 |
| 账簿 | `BD_AccountBook` | `FBOOKID,FNumber,FName,FDescription,FCreateOrgId,FUseOrgId,FIsSysPreset,FACCTTABLEID,FCURRENCYID,FBOOKTYPE,FAcctSystemID,FPeriodid` | 当前 finweb 按固定会计体系 ID 过滤 |
| 往来对象 | `FIN_OTHERS` | `FId,FNumber,FName,FCreateOrgId,FUseOrgId,FDescription,FCreateDate,FMODIFIERID,FMODIFYDATE` | 当前 finweb 按固定组织 ID 过滤 |
| 项目 | `BD_Project` | `FPROJECTID,FNumber,FName,FDescription,FCreateOrgId,FUseOrgId,FDocumentStatus` | 无通用安全默认值 |
| 项目兼容回退 | `BOS_ASSISTANTDATA_DETAIL` | `FId,FNumber,FDataValue,FDescription,FCreateOrgId,FUseOrgId,FDocumentStatus` | `BD_Project` 不适用时才尝试 |
| 币种 | `BD_Currency` | `FCURRENCYID,FNumber,FName,FCode,FPRICEDIGITS,FAMOUNTDIGITS,FDocumentStatus` | 无默认过滤 |
| 汇率 | `BD_Rate` | `FRateID,FRATETYPEID.FName,FBegDate,FEndDate,FCyForID.FNumber,FCyForID.FName,FCyToID.FNumber,FCyToID.FName,FExchangeRate,FReverseExRate,FDocumentStatus,FForbidStatus` | finweb 当前筛选汇率体系并按生效日倒序 |

Auto Voucher 默认逐类同步下列已审核表单；单类查询失败会写入同步日志，
不会阻断其他类型。页面只展示实际返回数据的分类。

| 分类 | FormId | 默认字段 |
|---|---|---|
| 组织 | `ORG_Organizations` | `FNumber,FName` |
| 账簿 | `BD_AccountBook` | `FNumber,FName` |
| 科目 | `BD_Account` | `FNumber,FName` |
| 客户 | `BD_Customer` | `FNumber,FName` |
| 供应商 | `BD_Supplier` | `FNumber,FName` |
| 部门 | `BD_Department` | `FNumber,FName` |
| 员工 | `BD_Empinfo` | `FNumber,FName` |
| 项目 | `BD_Project` | `FNumber,FName` |
| 其他往来 | `FIN_OTHERS` | `FNumber,FName` |
| 辅助资料类别 | `BOS_ASSISTANTDATA` | `FNumber,FName` |
| 辅助资料 | `BOS_ASSISTANTDATA_DETAIL` | `FId,FNumber,FDataValue` |
| 核算维度定义 | `BAS_FLEX` | `FNumber,FName` |
| 科目核算维度 | `BD_FLEXITEMPROPERTY` | `FNumber,FName` |
| 核算维度组 | `BD_FLEXITEMGROUP` | `FNumber,FName` |
| 核算维度值 | `BD_FLEXITEMDETAILV` | `FFlex4`–`FFLEX16`、`FF100002`–`FF100007` 的具体维度字段 |
| 费用项目 | `BD_Expense` | `FNumber,FName` |
| 币种 | `BD_Currency` | `FNumber,FName` |
| 税率 | `BD_TaxRate` | `FNumber,FName` |
| 计量单位 | `BD_UNIT` | `FNumber,FName` |
| 银行 | `CN_BANK` | `FNumber,FName` |
| 物料 | `BD_MATERIAL` | `FNumber,FName` |
| 仓库 | `BD_STOCK` | `FNumber,FName` |

2026-07-28 已使用隔离测试账套完成逐表只读验证。核心基础资料查询可以返回，
部分可选 FormId 可能为空或在目标账套中不存在；项目、银行和银行账号等值
可以按目标账套元数据改从 `BD_FLEXITEMDETAILV` 的具体维度字段获取。详细字段、
分页、去重和验收边界见
[金蝶K3Cloud主数据获取说明.md](./金蝶K3Cloud主数据获取说明.md)。
公开文档不记录测试账套的组织编码、内部 ID 或逐类数据量。该结果只证明
测试账套和当前 API 用户的查询能力，不代表其他客户账套具有
相同权限。

## 5. 凭证查询

### 5.1 列表查询

FormId：`GL_VOUCHER`

字段：

```text
FVOUCHERID,FBillNo,FDATE,FBUSDATE,FACCOUNTBOOKID,
FCREATORID,FMODIFIERID,FDOCUMENTSTATUS,FNOTENUMBER,
FCreateDate,FModifyDate
```

可组合过滤条件：

| 输入 | FilterString |
|---|---|
| `number` | `FBillNo LIKE '%值%'` |
| `dateFrom` | `FDATE >= 'YYYY-MM-DD'` |
| `dateTo` | `FDATE <= 'YYYY-MM-DD'` |

### 5.2 详情查询

调用：`View("GL_VOUCHER", data)`。

按编号：

```json
{
  "CreateOrgId": 0,
  "Number": "凭证号",
  "Id": "",
  "IsSortBySeq": "false"
}
```

按内部 ID：

```json
{
  "CreateOrgId": 0,
  "Number": "",
  "Id": "FVOUCHERID",
  "IsSortBySeq": "true"
}
```

## 6. 科目余额表查询

调用：`GetSysReportData`。

FormId：`GL_RPT_AccountBalance`。

```json
{
  "FormId": "GL_RPT_AccountBalance",
  "FilterString": "",
  "FilterParameter": {
    "FAccountBookID": "账簿 FBookId 或 FNumber",
    "FStartPeriod": "YYYY-MM",
    "FEndPeriod": "YYYY-MM",
    "FAccountNumberFrom": "",
    "FAccountNumberTo": "",
    "FCurrencyID": ""
  },
  "Limit": 2000,
  "StartRow": 0
}
```

目标金蝶版本可能使用不同报表 FormId 或参数结构，必须在测试账套核对。

## 7. 凭证草稿推送

调用：`Save("GL_VOUCHER", payload)`。

### 7.1 顶层参数

```json
{
  "NeedUpDateFields": [],
  "NeedReturnFields": [],
  "IsDeleteEntry": "true",
  "SubSystemId": "",
  "IsVerifyBaseDataField": "false",
  "IsEntryBatchFill": "true",
  "ValidateFlag": "true",
  "NumberSearch": "true",
  "IsAutoAdjustField": "true",
  "ValidateRepeatJson": "true",
  "IsAutoSubmitAndAudit": false,
  "Model": {}
}
```

`IsAutoSubmitAndAudit` 固定为 `false`。Auto Voucher 不调用 `Submit`、
`Audit` 或过账相关接口。

### 7.2 Model 参数

| 字段 | 来源/默认值 |
|---|---|
| `FAccountBookID.FNumber` | `ledger`，推送必填 |
| `FDate` | 凭证日期 `YYYY-MM-DD 00:00:00` |
| `FBUSDATE` | 凭证日期 `YYYY-MM-DD 00:00:00` |
| `FYEAR` | 凭证日期年份 |
| `FPERIOD` | 凭证日期月份 |
| `FVOUCHERGROUPID.FNumber` | `voucherGroup`；按目标账套的凭证字编码确认 |
| `FSourceBillKey.FNumber` | 本地幂等键 |
| `FDocumentStatus` | `Z` |
| `_antiDuplicate` | 本地幂等键 |
| `FEntity` | 凭证分录数组 |

### 7.3 分录参数

| 字段 | 来源/默认值 |
|---|---|
| `FEXPLANATION` | 摘要，并追加 `CVN:<幂等键>` 回查标记 |
| `FACCOUNTID.FNumber` | 科目编码 |
| `FCURRENCYID.FNumber` | 分录币种；按目标账套币种编码确认 |
| `FEXCHANGERATETYPE.FNumber` | 汇率类型；按目标账套汇率类型编码确认 |
| `FEXCHANGERATE` | 汇率；默认 `1` |
| `FAMOUNTFOR` | 原币金额 |
| `FDEBIT` | 借方金额 |
| `FCREDIT` | 贷方金额 |
| 配置化辅助核算字段 | `dimensionFieldMap` 映射后的 `{FNumber: 值}` |

### 7.4 保存成功判定

必须取得：

- 金蝶内部凭证 ID；
- 金蝶凭证编号。

缺少任一值时不能标记为已推送。

### 7.5 幂等回查

保存前后都使用同一个幂等键。网络超时或结果不确定时，查询：

```json
{
  "FormId": "GL_VOUCHER",
  "FieldKeys": "FVOUCHERID,FBillNo,FDocumentStatus",
  "FilterString": "FEXPLANATION LIKE '%CVN:<幂等键>%'",
  "OrderString": "FBillNo ASC",
  "TopRowCount": 20,
  "StartRow": 0,
  "Limit": 20
}
```

- 0 条：状态保持“待人工确认”，禁止自动重发。
- 1 个唯一 `FVOUCHERID`：可确认保存成功。
- 多个唯一 `FVOUCHERID`：标记冲突，必须人工核对。

## 8. 目标账套待确认参数

以下参数不能从其他环境直接沿用，也不能在公开文档中记录真实账套值：

| 参数 | 验收要求 |
|---|---|
| 组织内部 ID | 从目标测试账套读取并由实施人员确认 |
| 会计体系 ID | 从目标测试账套读取并与账簿关系核对 |
| 账簿编号 | 与凭证写入目标账簿逐项确认 |
| 银行科目范围 | 按目标科目表和企业核算规则配置 |
| 币种编码 | 使用目标账套的币种编码 |
| 凭证字编号 | 使用目标账套允许的凭证字 |
| 默认语言 | 按 API 用户与账套语言配置确认 |
| 登录组织编码 | 使用目标 API 用户获得授权的组织编码 |

在目标测试账套验收前，以上参数和辅助核算字段均视为待确认配置。

## 9. 后续 MCP 工具边界

第一批 MCP 工具建议固定为：

| 工具 | 输入 |
|---|---|
| `kingdee_probe` | 无业务参数；使用已保存连接配置 |
| `kingdee_query_master_data` | `type`、`keyword`、`limit` |
| `kingdee_query_vouchers` | `number`、`dateFrom`、`dateTo`、`limit` |
| `kingdee_get_voucher` | `voucherId` 或 `number`，二选一 |
| `kingdee_get_account_balance` | `ledger`、`startPeriod`、`endPeriod`、科目范围、币种 |
| `kingdee_preflight_voucher` | Auto Voucher 本地凭证 ID、预期环境 |
| `kingdee_save_voucher_draft` | 本地凭证 ID、预期环境、明确确认字段 |
| `kingdee_query_push_status` | 幂等键、外部 ID 或凭证编号 |

MCP 参数中禁止出现 AppSecret，禁止开放任意 FormId、任意过滤表达式和提交/审核工具。

## 10. 真实验收顺序

1. 测试账套真实查询 `BD_AccountBook`；
2. 查询一个已知科目；
3. 查询一个已知往来对象或项目；
4. 查询一个已知凭证并读取详情；
5. 查询一个已知期间的科目余额表；
6. 对平衡凭证执行本地预检；
7. 保存一张测试凭证草稿；
8. 使用外部 ID、编号和幂等标记回查；
9. 在金蝶后台核对账簿、日期、凭证字、摘要、科目、币种、金额和辅助核算。

只有第 9 步完成后，才能确认目标账套的查询和推送能力通过真实验收。
