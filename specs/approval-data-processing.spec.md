# Feature: 审批与银行联合数据处理

## Overview

“审批数据处理”以审批编号连接银行流水和审批记录，形成一张不丢失任一侧数据的全外连接表。审批原始数据保持只读，财务人员只在本地逐条补充科目、选择凭证场景，并为满足条件的数据生成可复核凭证草稿。

## Functional Requirements

### FR-001: 独立路由

When the user opens the 审批数据处理 workflow card, the system shall navigate to `/workspace/approval-processing`.

### FR-002: 审批原始数据只读

The system shall preserve synchronized approval fields and original source records without modification.

### FR-003: 多选确认传递

While the user is viewing approval records, when one or more records are selected and explicitly confirmed, the system shall persist the confirmation and pass only confirmed approval records into approval data processing.

### FR-004: 多字段自定义筛选

While the user is viewing approval records, when multiple custom field conditions are configured, the system shall filter records using field-appropriate operators and require every condition to match.

### FR-005: 可撤回传递

While confirmed approval records have not been converted into source mutations, when the user selects them and cancels transfer, the system shall exclude them from subsequent approval processing without modifying the original records.

### FR-006: 本地逐条科目

While an approval record exists, when the user selects an account, the system shall add or update only the record's local debit-account enrichment fields.

### FR-007: 有效科目约束

When the user selects a local debit account, the system shall accept only active account master data that is not disabled.

### FR-008: 全外连接

When bank and approval records are loaded, the system shall create a full outer join by approval number and retain matched, bank-only, approval-only, and amount-mismatch rows.

### FR-009: 左右字段分区

The system shall display bank fields on the left, approval fields on the right, and matching plus local processing fields between or after them.

### FR-010: 匹配状态不进入异常清单

The system shall keep bank-only, approval-only, and amount-mismatch rows in the union table and shall not create exception-list records solely because of those statuses.

### FR-011: 自动生成条件

While a row has both sources, equal amounts, a valid local approval account, and an enabled complete matching scenario, when automatic generation is run, the system shall generate a voucher draft.

### FR-012: 手动场景选择

While a row is bank-only, approval-only, amount-mismatched, or needs an explicit override, when the user selects an enabled complete scenario, the system shall generate a voucher draft only after normal account, field, and balance validation succeeds.

### FR-013: 科目来源字段

Where a scenario line uses `审批数据处理 · 科目`, the system shall resolve the account from the approval record's local enrichment and validate it against current active account master data during generation.

### FR-014: 来源追溯

When a voucher is generated from a union row, the system shall store both available source event IDs, the approval number, amounts, match status, selected scenario, and automatic or manual selection mode.

### FR-015: 场景选择持久化

When the user manually selects a scenario for a union row, the system shall persist the selection locally so it survives rerender and restart.

## Non-Functional Requirements

### Performance

- The table shall derive union rows in memory without network calls.
- Rendering may be bounded when source data grows, but matching and saved processing shall cover all local rows.

### Security

- No connector secret may be added to union rows, audit logs, or voucher explanations.
- Only active account master data may be assigned.
- Original approval documents and structured source records remain immutable.

### Reliability

- Duplicate voucher generation for the same union source set shall be prevented.
- A failed account save or bulk automatic generation shall restore the prior local state.
- Manual scenario selection shall not bypass voucher balance or required-field validation.

## Acceptance Criteria

### AC-001: Full outer join

Given matched, bank-only, approval-only, and amount-mismatched source records
When the union table is built
Then all four statuses are present
And no source record is silently discarded.

### AC-002: Confirmed approval gate

Given multiple approval records exist
When the user selects a subset and confirms transfer
Then only that subset is available to approval data processing
And unconfirmed approval records remain visible and unchanged in approval records.

### AC-003: Revoked approval

Given an approval record was previously confirmed
When the user selects it and cancels transfer
Then it is excluded from approval data processing
And its synchronized source data remains unchanged.

### AC-004: Multi-field custom filter

Given approval records differ by template, reference, department, project, date, amount, status, or other supported fields
When the user adds multiple complete custom conditions and applies them
Then only records satisfying every condition are displayed
And the available operators match each selected field type.

### AC-005: Local account without source mutation

Given an approval record with archived source records
When the user chooses an active account
Then the local debit-account ID, code and name are saved
And the source records remain unchanged.

### AC-006: Automatic matched draft

Given a union row has equal bank and approval amounts
And the approval has a valid local account
And an enabled complete scenario matches
When automatic generation runs
Then one balanced voucher draft is created
And the voucher references both source events.

### AC-007: Manual scene for non-matched row

Given a bank-only, approval-only, or amount-mismatched row
When the user selects an enabled scenario and generates
Then the selected scenario is used
And no matching-status exception is created.

### AC-008: Dynamic approval account

Given a scenario line uses `审批数据处理 · 科目`
When a voucher is generated
Then the line uses the selected active account
And generation is rejected if that account is missing or inactive.

### AC-009: Duplicate protection

Given a voucher already references any source event in a union row
When the union page is rendered again
Then the row shows the existing voucher
And a second generate action is unavailable.

## Error Handling

| Error Condition | Handling | User Message |
|---|---|---|
| 科目为空或已停用 | 阻止保存或生成 | 请选择当前有效的科目主数据 |
| 未匹配数据未选择场景 | 阻止生成 | 请先手动选择已启用的凭证场景 |
| 自动匹配无可用场景 | 保留联合行 | 没有自动命中的已启用凭证场景 |
| 场景所需字段缺失 | 阻止生成 | 显示具体缺失字段或科目 |
| 借贷不平 | 阻止生成 | 显示凭证校验错误 |
| 状态保存失败 | 回滚本地修改 | 沿用本地服务保存错误及支持编号 |

## Implementation TODO

### State and domain

- [x] 初始化持久化的审批记录确认状态
- [x] 仅将已确认审批记录传递到审批数据处理
- [x] 初始化持久化的联合场景选择状态
- [x] 实现审批编号全外连接和四种匹配状态
- [x] 实现逐条本地科目赋值与有效主数据校验
- [x] 实现联合凭证事件和双侧来源追溯
- [x] 场景科目支持固定科目或审批处理字段

### Frontend

- [x] 增加可增删的多字段自定义 AND 筛选器
- [x] 按字段类型限制运算符和输入控件
- [x] 在审批记录中增加逐条、多选和全选
- [x] 增加确认传递、取消传递和确认状态显示
- [x] 将审批处理页改为银行左、审批右的联合表
- [x] 增加逐条科目选择
- [x] 增加手动场景选择及持久化
- [x] 增加单行生成和全部可自动项生成
- [x] 显示已有凭证并阻止重复生成

### Testing

- [x] 覆盖跨字段 AND 组合与字段类型运算符
- [x] 覆盖多选确认、撤回与未确认记录隔离
- [x] 覆盖四种全外连接状态
- [x] 覆盖原始审批记录不变与停用科目拒绝
- [x] 覆盖动态科目生成和双侧来源 ID
- [x] 完成完整前端、后端、构建和浏览器回归

## Out of Scope

- 自动拆分一单多付或多单合付。
- 自动提交、审核或过账凭证。
- 把未匹配或金额不一致本身写入异常清单。
