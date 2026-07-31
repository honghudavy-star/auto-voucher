import test from "node:test";
import assert from "node:assert/strict";

import {
  applyApprovalProcessing,
  assignApprovalCounterpartyFromField,
  approvalConditionComplete,
  approvalCompletionDate,
  approvalFieldDisplayValue,
  approvalProcessingFieldsForConnector,
  approvalProfileForConnector,
  approvalProfilesForConnector,
  approvalProcessingOperators,
  approvalRecordFieldEntries,
  approvalRecordMatchesCondition,
  approvalRecordsForProcessing,
  filterApprovalRecordsByCompletionDate,
  filterApprovalRecordsByProfile,
  filterApprovalRecords,
  isApprovalRecord,
  normalizeApprovalProcessingConfirmations,
  updateApprovalProcessingConfirmations,
} from "../src/approval-processing.js";
import {
  assignApprovalAccount,
  buildApprovalBankUnion,
  buildUnionVoucherEvent,
  isBankRecord,
} from "../src/approval-bank-union.js";

const approvals = [
  {
    id: "EV-1",
    sourceSystem: "feishu",
    approvalStatus: "approved",
    department: "市场部",
    project: "品牌升级",
    amountCents: 120_000,
  },
  {
    id: "EV-2",
    sourceSystem: "feishu",
    approvalStatus: "approved",
    department: "市场部",
    project: "客户活动",
    amountCents: 80_000,
  },
  {
    id: "EV-3",
    sourceSystem: "local-files",
    approvalStatus: "unknown",
    department: "市场部",
    project: "品牌升级",
    amountCents: 120_000,
  },
];

test("审批连接器兼容旧配置并支持多个 approval_code 模板", () => {
  const legacy = {
    approvalCode: "APPROVAL-LEGACY",
    approvalName: "旧付款审批",
    approvalFields: [{ id: "legacy-party", name: "旧供应商", type: "input" }],
    fieldMapping: { counterparty: "legacy-party" },
  };
  assert.deepEqual(
    approvalProfilesForConnector(legacy).map((profile) => profile.approvalCode),
    ["APPROVAL-LEGACY"],
  );

  const connector = {
    approvalProfiles: [
      {
        id: "PROFILE-1",
        approvalCode: "APPROVAL-1",
        approvalName: "付款审批",
        approvalFields: [{ id: "party-1", name: "供应商", type: "input" }],
      },
      {
        id: "PROFILE-2",
        approvalCode: "APPROVAL-2",
        approvalName: "费用审批",
        approvalFields: [{ id: "party-2", name: "收款方", type: "input" }],
      },
    ],
  };
  assert.equal(
    approvalProfileForConnector(connector, "PROFILE-2")?.approvalCode,
    "APPROVAL-2",
  );
  assert.equal(
    approvalProfileForConnector(connector)?.approvalCode,
    "APPROVAL-1",
  );
  assert.equal(
    approvalProfileForConnector(connector, ""),
    null,
    "新增模板的空 profileId 不能回退到旧模板",
  );
  const fields = approvalProcessingFieldsForConnector(connector);
  assert.ok(fields.some((field) => field.key === "approvalField:party-1"));
  assert.ok(fields.some((field) => field.key === "approvalField:party-2"));
  const profileFields = approvalProcessingFieldsForConnector(connector, "PROFILE-1");
  assert.ok(profileFields.some((field) => field.key === "approvalField:party-1"));
  assert.equal(
    profileFields.some((field) => field.key === "approvalField:party-2"),
    false,
  );
});

test("审批记录严格跟随当前 approval_code 模板", () => {
  const records = [
    { id: "A-1", approvalCode: "APPROVAL-A" },
    { id: "B-1", approvalCode: "APPROVAL-B" },
    { id: "LEGACY", approvalCode: "" },
  ];

  assert.deepEqual(
    filterApprovalRecordsByProfile(records, "APPROVAL-A")
      .map((record) => record.id),
    ["A-1"],
  );
  assert.deepEqual(filterApprovalRecordsByProfile(records, ""), []);
});

test("完成日期范围只筛选本地审批完成时间", () => {
  const records = [
    {
      id: "APR-COMPLETED-IN-RANGE",
      sourceSystem: "feishu",
      approvalCompletedAt: "2026-07-15T08:30:00+00:00",
      approvalCompletedDate: "2026-07-15",
    },
    {
      id: "APR-COMPLETED-BEFORE-RANGE",
      sourceSystem: "feishu",
      approvalCompletedAt: "2026-06-30T23:30:00+00:00",
      approvalCompletedDate: "2026-06-30",
    },
    {
      id: "APR-WITHOUT-COMPLETION",
      sourceSystem: "feishu",
    },
  ];

  assert.equal(approvalCompletionDate(records[0]), "2026-07-15");
  assert.deepEqual(
    filterApprovalRecordsByCompletionDate(records, "2026-07-01", "2026-07-29")
      .map((record) => record.id),
    ["APR-COMPLETED-IN-RANGE"],
  );
  assert.equal(
    filterApprovalRecordsByCompletionDate(records, "", ""),
    records,
  );
});

test("审批处理条件按 AND 组合，并以元输入匹配分币金额", () => {
  const result = filterApprovalRecords(approvals, [
    { field: "department", operator: "equals", value: "市场部" },
    { field: "project", operator: "contains", value: "品牌" },
    { field: "amountCents", operator: "greaterThan", value: "1000" },
  ]);

  assert.deepEqual(result.map((item) => item.id), ["EV-1"]);
  assert.equal(isApprovalRecord(approvals[2]), false);
});

test("不完整条件不会意外匹配全部审批数据", () => {
  assert.equal(approvalConditionComplete({
    field: "department",
    operator: "equals",
    value: "",
  }), false);
  assert.deepEqual(filterApprovalRecords(approvals, [
    { field: "department", operator: "equals", value: "" },
  ]), []);
});

test("审批记录自定义筛选支持跨字段 AND 组合和字段类型运算符", () => {
  const records = [
    {
      id: "APR-FILTER-1",
      sourceSystem: "feishu",
      approvalStatus: "approved",
      approvalName: "付款申请",
      reference: "SP-20260730-001",
      department: "市场部",
      amountCents: 125_000,
    },
    {
      id: "APR-FILTER-2",
      sourceSystem: "feishu",
      approvalStatus: "approved",
      approvalName: "付款申请",
      reference: "SP-20260730-002",
      department: "研发部",
      amountCents: 125_000,
    },
  ];
  const result = filterApprovalRecords(records, [
    { field: "approvalName", operator: "contains", value: "付款" },
    { field: "reference", operator: "startsWith", value: "SP-20260730" },
    { field: "department", operator: "equals", value: "市场部" },
    { field: "amountCents", operator: "greaterThan", value: "1000" },
  ]);

  assert.deepEqual(result.map((record) => record.id), ["APR-FILTER-1"]);
  assert.equal(
    approvalProcessingOperators("amountCents").some((operator) => operator.key === "greaterThan"),
    true,
  );
  assert.equal(
    approvalProcessingOperators("amountCents").some((operator) => operator.key === "contains"),
    false,
  );
});

test("审批模板全部字段进入动态筛选目录并按实际类型取值", () => {
  const fields = approvalProcessingFieldsForConnector({
    approvalFields: [
      { id: "widget-party", name: "付款主体", type: "input" },
      { id: "widget-amount", name: "明细金额", type: "amount" },
      { id: "widget-date", name: "期望付款日期", type: "date" },
      { id: "widget-empty", name: "特殊备注", type: "input" },
    ],
  });
  const record = {
    id: "APR-DYNAMIC-1",
    sourceSystem: "feishu",
    approvalStatus: "approved",
    approvalFieldValues: [
      { id: "widget-party", name: "付款主体", value: "示例科技有限公司" },
      { id: "widget-amount", name: "明细金额", value: [100, 28] },
      { id: "widget-date", name: "期望付款日期", value: "1784851200000" },
      { id: "widget-empty", name: "特殊备注", value: "" },
    ],
  };

  assert.equal(fields.length, 16);
  assert.equal(
    fields.find((field) => field.key === "approvalCompletedDate")?.label,
    "完成日期",
  );
  assert.equal(
    fields.find((field) => field.key === "approvalField:widget-amount")?.type,
    "money",
  );
  assert.equal(
    fields.find((field) => field.key === "approvalField:widget-date")?.type,
    "date",
  );
  assert.equal(approvalRecordMatchesCondition(record, {
    field: "approvalField:widget-party",
    operator: "contains",
    value: "示例科技",
  }, fields), true);
  assert.equal(approvalRecordMatchesCondition(record, {
    field: "approvalField:widget-amount",
    operator: "equals",
    value: "128",
  }, fields), true);
  assert.equal(approvalRecordMatchesCondition(record, {
    field: "approvalField:widget-date",
    operator: "equals",
    value: "2026-07-24",
  }, fields), true);
  assert.equal(approvalRecordMatchesCondition(record, {
    field: "approvalField:widget-empty",
    operator: "isEmpty",
    value: "",
  }, fields), true);
});

test("单条审批可从自身任意非空字段替换供应商并保留字段来源", () => {
  const record = {
    id: "APR-COUNTERPARTY-1",
    sourceSystem: "feishu",
    approvalStatus: "approved",
    counterparty: "原映射供应商",
    approvalFieldValues: [
      { id: "widget-party", name: "付款主体", type: "input", value: "资产端" },
      {
        id: "widget-company",
        name: "签约主体全称",
        type: "input",
        value: ["易点大（上海）数字科技有限公司"],
      },
      { id: "widget-empty", name: "备用供应商", type: "input", value: "" },
    ],
  };
  const untouched = {
    id: "APR-COUNTERPARTY-2",
    counterparty: "另一供应商",
  };

  assert.equal(
    approvalFieldDisplayValue({ name: "易点大", code: "YD" }),
    "易点大 / YD",
  );
  assert.deepEqual(
    approvalRecordFieldEntries(record).map((field) => [
      field.id,
      field.name,
      field.displayValue,
    ]),
    [
      ["widget-party", "付款主体", "资产端"],
      ["widget-company", "签约主体全称", "易点大（上海）数字科技有限公司"],
      ["widget-empty", "备用供应商", ""],
    ],
  );

  assignApprovalCounterpartyFromField({
    record,
    fieldId: "widget-company",
    selectedAt: "2026-07-30T12:00:00.000Z",
    selectedBy: "财务甲",
  });

  assert.equal(record.counterparty, "易点大（上海）数字科技有限公司");
  assert.equal(record.counterpartyMappedValue, "原映射供应商");
  assert.deepEqual(record.counterpartyFieldSelection, {
    fieldId: "widget-company",
    fieldName: "签约主体全称",
    selectedAt: "2026-07-30T12:00:00.000Z",
    selectedBy: "财务甲",
  });
  assert.equal(untouched.counterparty, "另一供应商");
  assert.throws(
    () => assignApprovalCounterpartyFromField({
      record,
      fieldId: "widget-empty",
      selectedAt: "2026-07-30T12:01:00.000Z",
      selectedBy: "财务甲",
    }),
    /所选审批字段没有可用值/,
  );
});

test("只有人工确认的审批记录会传递到审批数据处理", () => {
  const records = [
    ...structuredClone(approvals),
    {
      id: "BANK-1",
      sourceSystem: "local-files",
      reference: "SP-001",
      sourceRecords: [{ documentType: "银行流水" }],
    },
  ];
  const confirmations = updateApprovalProcessingConfirmations({
    records,
    confirmations: {},
    recordIds: ["EV-1"],
    confirmed: true,
    confirmedAt: "2026-07-30T08:00:00.000Z",
    confirmedBy: "财务甲",
  });
  const passed = approvalRecordsForProcessing(records, confirmations);

  assert.deepEqual(passed.map((record) => record.id), ["EV-1", "EV-3", "BANK-1"]);
  assert.deepEqual(confirmations["EV-1"], {
    confirmedAt: "2026-07-30T08:00:00.000Z",
    confirmedBy: "财务甲",
  });
  assert.equal(passed.some((record) => record.id === "EV-2"), false);
});

test("确认集合支持多选撤回，并拒绝不存在或非审批记录", () => {
  const confirmed = updateApprovalProcessingConfirmations({
    records: approvals,
    confirmations: {},
    recordIds: ["EV-1", "EV-2", "EV-2"],
    confirmed: true,
    confirmedAt: "2026-07-30T08:00:00.000Z",
    confirmedBy: "财务甲",
  });
  const revoked = updateApprovalProcessingConfirmations({
    records: approvals,
    confirmations: confirmed,
    recordIds: ["EV-2"],
    confirmed: false,
  });

  assert.deepEqual(Object.keys(revoked), ["EV-1"]);
  assert.deepEqual(normalizeApprovalProcessingConfirmations({ "EV-1": true, invalid: null }), {
    "EV-1": {},
  });
  assert.throws(() => updateApprovalProcessingConfirmations({
    records: approvals,
    confirmations: confirmed,
    recordIds: ["EV-3", "missing"],
    confirmed: true,
  }), /至少选择一条有效的审批记录/);
});

test("不同审批模板分开传递并在审批数据处理中累计保留", () => {
  const records = [
    { id: "A-1", sourceSystem: "feishu", approvalCode: "APPROVAL-A" },
    { id: "B-1", sourceSystem: "feishu", approvalCode: "APPROVAL-B" },
  ];
  const afterA = updateApprovalProcessingConfirmations({
    records,
    confirmations: {},
    recordIds: ["A-1"],
    confirmed: true,
    confirmedAt: "2026-07-30T08:00:00.000Z",
    confirmedBy: "财务甲",
  });
  const afterB = updateApprovalProcessingConfirmations({
    records,
    confirmations: afterA,
    recordIds: ["B-1"],
    confirmed: true,
    confirmedAt: "2026-07-30T08:05:00.000Z",
    confirmedBy: "财务甲",
  });

  assert.deepEqual(Object.keys(afterB), ["A-1", "B-1"]);
  assert.deepEqual(
    approvalRecordsForProcessing(records, afterB).map((record) => record.id),
    ["A-1", "B-1"],
  );
});

test("保存处理结果只更新匹配记录并保留可追溯信息", () => {
  const records = structuredClone(approvals);
  const processed = applyApprovalProcessing({
    records,
    conditions: [
      { field: "project", operator: "equals", value: "品牌升级" },
    ],
    account: { id: "MD-5602", code: "5602", name: "管理费用" },
    ruleId: "APR-1",
    processedAt: "2026-07-29T12:00:00.000Z",
    processedBy: "财务甲",
  });

  assert.deepEqual(processed.map((item) => item.id), ["EV-1"]);
  assert.equal(records[0].debitAccountCode, "5602");
  assert.equal(records[0].debitAccountName, "管理费用");
  assert.deepEqual(records[0].approvalProcessing, {
    status: "processed",
    ruleId: "APR-1",
    processedAt: "2026-07-29T12:00:00.000Z",
    processedBy: "财务甲",
  });
  assert.equal(records[1].debitAccountCode, undefined);
  assert.equal(records[2].debitAccountCode, undefined);
});

test("无匹配记录或无有效科目时拒绝保存", () => {
  assert.throws(() => applyApprovalProcessing({
    records: structuredClone(approvals),
    conditions: [{ field: "department", operator: "equals", value: "不存在" }],
    account: { id: "MD-5602", code: "5602", name: "管理费用" },
    ruleId: "APR-2",
    processedAt: "2026-07-29T12:00:00.000Z",
    processedBy: "财务甲",
  }), /没有匹配/);
  assert.throws(() => applyApprovalProcessing({
    records: structuredClone(approvals),
    conditions: [{ field: "department", operator: "equals", value: "市场部" }],
    account: {},
    ruleId: "APR-3",
    processedAt: "2026-07-29T12:00:00.000Z",
    processedBy: "财务甲",
  }), /有效的借方科目/);
});

test("银行与审批按审批编号取全外连接并保留四种处理状态", () => {
  const events = [
    {
      id: "APR-MATCH",
      sourceSystem: "feishu",
      externalId: "SP-001",
      reference: "SP-001",
      approvalStatus: "approved",
      amountCents: 10_000,
    },
    {
      id: "BANK-MATCH",
      reference: "SP-001",
      amountCents: 10_000,
      sourceRecords: [{
        documentType: "银行流水",
        amountCents: 10_000,
        referenceFields: { approvalNo: "SP-001", bankSerial: "BANK-001" },
      }],
    },
    {
      id: "APR-DIFF",
      sourceSystem: "feishu",
      externalId: "SP-002",
      reference: "SP-002",
      approvalStatus: "approved",
      amountCents: 20_000,
    },
    {
      id: "BANK-DIFF",
      reference: "SP-002",
      amountCents: 18_000,
      sourceRecords: [{
        documentType: "银行流水",
        amountCents: 18_000,
        referenceFields: { approvalNo: "SP-002", bankSerial: "BANK-002" },
      }],
    },
    {
      id: "APR-ONLY",
      sourceSystem: "feishu",
      externalId: "SP-003",
      reference: "SP-003",
      approvalStatus: "approved",
      amountCents: 30_000,
    },
    {
      id: "BANK-ONLY",
      reference: "SP-004",
      amountCents: 40_000,
      sourceRecords: [{
        documentType: "银行流水",
        amountCents: 40_000,
        referenceFields: { approvalNo: "SP-004", bankSerial: "BANK-004" },
      }],
    },
  ];

  const rows = buildApprovalBankUnion(events);
  assert.deepEqual(
    Object.fromEntries(rows.map((row) => [row.reference, row.status])),
    {
      "SP-001": "matched",
      "SP-002": "amount_mismatch",
      "SP-003": "approval_only",
      "SP-004": "bank_only",
    },
  );
  assert.equal(rows.find((row) => row.reference === "SP-002").amountDifferenceCents, -2_000);
});

test("银行联合表按借方正数、贷方负数显示且审批匹配仍按金额绝对值", () => {
  const rows = buildApprovalBankUnion([
    {
      id: "APR-OUTFLOW",
      sourceSystem: "feishu",
      externalId: "SP-OUTFLOW",
      reference: "SP-OUTFLOW",
      approvalStatus: "approved",
      amountCents: 50_000,
    },
    {
      id: "BANK-OUTFLOW",
      reference: "SP-OUTFLOW",
      amountCents: 50_000,
      bankDirection: "outflow",
      sourceRecords: [{
        documentType: "银行流水",
        amountCents: 50_000,
        referenceFields: {
          approvalNo: "SP-OUTFLOW",
          bankSerial: "BANK-OUTFLOW",
          bankDirection: "outflow",
        },
      }],
    },
    {
      id: "BANK-INFLOW",
      reference: "BANK-INFLOW",
      amountCents: 12_000,
      bankDirection: "inflow",
      sourceRecords: [{
        documentType: "银行流水",
        amountCents: 12_000,
        referenceFields: {
          bankSerial: "BANK-INFLOW",
          bankDirection: "inflow",
        },
      }],
    },
  ]);

  const outflow = rows.find((row) => row.reference === "SP-OUTFLOW");
  const inflow = rows.find((row) => row.reference === "BANK-INFLOW");
  assert.equal(outflow.bankAmountCents, 50_000);
  assert.equal(outflow.bankSignedAmountCents, -50_000);
  assert.equal(outflow.amountDifferenceCents, 0);
  assert.equal(outflow.status, "matched");
  assert.equal(inflow.bankSignedAmountCents, 12_000);
});

test("审批摘要提到对账或银行名称时不会被误判为银行流水", () => {
  assert.equal(isBankRecord({
    id: "APR-PAYMENT",
    sourceSystem: "feishu",
    approvalStatus: "approved",
    approvalName: "付款申请",
    type: "采购付款",
    summary: "运营对账见附件，收款信息包含银行名称",
    sourceRecords: [{
      documentType: "业务资料",
      referenceFields: { approvalNo: "SP-PAYMENT", bankSerial: "" },
    }],
  }), false);
});

test("逐条选择科目只增加本地处理字段并要求有效科目主数据", () => {
  const record = {
    id: "APR-LOCAL",
    sourceSystem: "feishu",
    externalId: "SP-LOCAL",
    approvalStatus: "approved",
    sourceRecords: [{ documentId: "DOC-RAW", amountCents: 12_000 }],
  };
  const originalSources = structuredClone(record.sourceRecords);
  assignApprovalAccount(
    record,
    {
      id: "MD-5602",
      category: "account",
      code: "5602",
      name: "管理费用",
      active: true,
    },
    "财务甲",
    "2026-07-29T12:00:00.000Z",
  );

  assert.deepEqual(record.sourceRecords, originalSources);
  assert.equal(record.debitAccountMasterDataId, "MD-5602");
  assert.equal(record.debitAccountCode, "5602");
  assert.equal(record.approvalProcessing.mode, "manual");
  assert.throws(() => assignApprovalAccount(record, {
    id: "MD-OFF",
    category: "account",
    code: "9999",
    name: "停用科目",
    active: false,
  }), /有效的科目主数据/);
});

test("联合凭证事件优先使用银行实付金额并携带两侧来源", () => {
  const row = buildApprovalBankUnion([
    {
      id: "APR-5",
      sourceSystem: "feishu",
      externalId: "SP-005",
      reference: "SP-005",
      approvalStatus: "approved",
      amountCents: 50_000,
      counterparty: "供应商甲",
      debitAccountMasterDataId: "MD-5602",
      debitAccountCode: "5602",
      debitAccountName: "管理费用",
    },
    {
      id: "BANK-5",
      reference: "SP-005",
      date: "2026-07-29",
      amountCents: 50_000,
      sourceRecords: [{
        documentType: "银行流水",
        amountCents: 50_000,
        referenceFields: { approvalNo: "SP-005", bankSerial: "BANK-005" },
      }],
    },
  ])[0];
  const event = buildUnionVoucherEvent(row);

  assert.equal(event.amountCents, 50_000);
  assert.equal(event.amountBreakdown.paymentCents, 50_000);
  assert.equal(event.debitAccountCode, "5602");
  assert.deepEqual(event.unionSourceEventIds.sort(), ["APR-5", "BANK-5"]);
  assert.deepEqual(event.exceptionIds, []);
});
