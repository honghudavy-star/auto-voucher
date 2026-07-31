# 金蝶 K3Cloud 主数据获取说明

> 记录日期：2026-07-28
>
> 适用范围：Auto Voucher 金蝶云星空连接器及后续 MCP 只读查询工具
>
> 当前验证环境：已连接的金蝶测试账套
>
> 安全边界：只调用查询接口，不提交、修改或删除金蝶数据

## 1. 获取方式

主数据通过金蝶官方 Python SDK 的 `ExecuteBillQuery` 获取，认证方式与
`finweb` 一致：

- `serverUrl`：K3Cloud WebAPI 根地址；
- `acctId`：API 数据中心/账套 ID；
- `username`：API 用户；
- `appId`：第三方应用 ID；
- `app_secret`：第三方应用密钥，只保存在操作系统密钥库；
- `orgNum`：登录组织编码，无通用默认值，按目标账套确认；
- `localeId`：语言，默认 `2052`。

`ledger` 是凭证目标账簿编号，不参与主数据查询认证。完整认证参数和凭证
推送参数见 [金蝶K3Cloud查询与推送参数.md](./金蝶K3Cloud查询与推送参数.md)。

## 2. 通用查询参数

每类主数据使用一个经过审核的 FormId 和字段列表，不允许前端或 MCP
调用方任意传入 FormId。

```json
{
  "FormId": "BD_Customer",
  "FieldKeys": "FNumber,FName",
  "FilterString": "",
  "OrderString": "",
  "TopRowCount": 0,
  "StartRow": 0,
  "Limit": 2000
}
```

| 参数 | 规则 |
|---|---|
| `FormId` | 来自下方白名单 |
| `FieldKeys` | 白名单内固定字段，不接收任意 SQL/字段表达式 |
| `FilterString` | 默认空；只有经过配置审核的过滤条件才可使用 |
| `OrderString` | 当前为空 |
| `TopRowCount` | 固定 `0`，由分页控制总量 |
| `StartRow` | 首页 `0`，后续按已获取行数递增 |
| `Limit` | 每页最多 `2000` |
| 总量上限 | 单个类型最多 `100000` 行 |

分页持续到返回行数小于 `Limit`。因此不会再把刚好达到 10,000 行的结果
误判为完整数据。

## 3. 主数据白名单

| 业务分类 | FormId | 查询字段 | 本地编码/名称 | 本地唯一标识 |
|---|---|---|---|---|
| 组织 | `ORG_Organizations` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 账簿 | `BD_AccountBook` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 科目 | `BD_Account` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 客户 | `BD_Customer` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 供应商 | `BD_Supplier` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 部门 | `BD_Department` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 员工 | `BD_Empinfo` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 项目 | `BD_Project` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 其他往来 | `FIN_OTHERS` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 辅助资料类别 | `BOS_ASSISTANTDATA` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 辅助资料 | `BOS_ASSISTANTDATA_DETAIL` | `FId,FNumber,FDataValue` | `FNumber` / `FDataValue` | `FId + FNumber` |
| 核算维度定义 | `BAS_FLEX` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 科目核算维度 | `BD_FLEXITEMPROPERTY` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 核算维度组 | `BD_FLEXITEMGROUP` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 核算维度值视图 | `BD_FLEXITEMDETAILV` | `FFlex4`–`FFLEX16`、`FF100002`–`FF100007` 对应字段 | 依维度字段确定 | 分类 + 编码 |
| 费用项目 | `BD_Expense` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 币种 | `BD_Currency` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 税率 | `BD_TaxRate` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 计量单位 | `BD_UNIT` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 银行 | `CN_BANK` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 物料 | `BD_MATERIAL` | `FNumber,FName` | `FNumber` / `FName` | 编码 |
| 仓库 | `BD_STOCK` | `FNumber,FName` | `FNumber` / `FName` | 编码 |

辅助资料的 `FId` 是类别标识，不是明细行唯一 ID，因此本地使用
`FId + FNumber` 作为复合唯一标识。只使用 `FId` 会把同一类别下的不同
明细互相覆盖。

`BD_FLEXITEMDETAILV` 是核算维度值视图，不存在通用的 `FNumber/FName`
字段。当前账套元数据中可见的维度字段包括供应商、部门、客户、员工、
物料、费用项目、组织机构、银行、银行账号、其他往来单位、服务类型、
单位、入账地区、旧项目和新项目。该视图必须按具体维度字段查询，不能
套用普通基础资料字段。

## 4. 本地处理规则

1. 每个分类独立查询；一个分类失败时继续同步其他分类。
2. 每次成功响应先按完整 JSON 归档，并保存 SHA-256 摘要。
3. 查询结果按业务唯一标识合并；同一编码重复出现时选取稳定的规范名称。
4. 名称变化时停用旧版本并新增版本，不覆盖历史记录。
5. 重复同步如果远端数据未变化，新增/更新数应为 `0`。
6. 页面只展示实际存在数据的分类；空结果、当前账套不可用和失败类型保留在同步日志中。
7. 表格默认每页 50 条，支持分类、来源、版本状态和关键词筛选。

同步日志的每类结果。以下数值只示意字段结构，不对应任何真实账套：

```json
{
  "category": "customer",
  "formId": "BD_Customer",
  "status": "completed",
  "rows": 1,
  "created": 0
}
```

`status` 可能是：

- `completed`：查询成功且返回数据；
- `empty`：查询成功但当前账套没有数据；
- `unavailable`：可选 FormId 不存在于当前账套，已使用当前元数据中的替代维度字段；
- `failed`：FormId、字段、权限或远端调用失败。

## 5. 测试账套只读验收边界

2026-07-28 已在隔离测试账套完成稳定重跑，验证以下行为：

| 验收项 | 结果 |
|---|---|
| 核心基础资料 | 科目、客商、组织、账簿、部门、员工、辅助资料等分类可以独立查询 |
| 可选基础资料 | 允许返回空结果，不把空结果误判为连接失败 |
| 可选 FormId | 目标账套不存在时记录为 `unavailable`，继续同步其他分类 |
| 核算维度值 | 按目标账套元数据中的具体维度字段拆分，不假设固定字段全集 |
| 重复同步 | 远端数据未变化时不重复新增或覆盖历史版本 |
| 失败隔离 | 单个分类失败不阻断其他分类，失败原因进入同步日志 |

公开文档不记录测试账套的组织编码、内部 ID、业务对象名称或逐类数据量。
以上结果仅代表该测试环境、当前 API 用户及当前授权。其他客户账套需要
重新执行连接探测和逐类同步，不能直接沿用可用状态。

## 6. 后续 MCP 工具契约

建议只提供受控工具，不暴露通用 FormId 查询：

### `kingdee_list_master_data`

输入：

```json
{
  "category": "customer",
  "search": "",
  "status": "active",
  "page": 1,
  "pageSize": 50
}
```

约束：

- `category` 必须来自连接器当前白名单；
- `pageSize` 最大 200；
- 默认查询本地已同步、已归档的数据；
- 返回来源、同步时间和版本，不返回认证信息。

### `kingdee_sync_master_data`

输入：

```json
{
  "categories": ["customer", "supplier", "accountDimension"]
}
```

约束：

- 只允许白名单分类；
- 空数组表示同步全部白名单；
- 返回逐类 `completed/empty/unavailable/failed` 结果；
- 不调用任何保存、提交、审核、删除或过账接口。

### `kingdee_get_master_data_sync_log`

输入：

```json
{
  "limit": 20
}
```

返回同步时间、分类、FormId、原始行数、新增/更新数、状态和脱敏后的错误
信息，用于解释“同步了多少、为什么页面没有数据”。
