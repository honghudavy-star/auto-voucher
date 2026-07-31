import test from "node:test";
import assert from "node:assert/strict";

import {
  applyVoucherLineEdits,
  buildIdempotencyKey,
  buildLedger,
  createPurchaseVoucher as createVoucherWithRule,
  eligibleForBatchConfirmation,
  eventFromRow,
  filterLocalRecords,
  parseCsv,
  renderSummaryTemplate,
  resolveKingdeeExchangeRate,
  selectPostingRule,
  splitEventForPartialPayment,
  toCents,
  validateVoucher,
  createRuleFromVoucherEdit,
  createRuleVersion,
} from "../src/domain.js";

const event = {
  id: "EV-TEST",
  company: "示例科技有限公司",
  ledger: "人民币账套",
  date: "2026-07-24",
  counterparty: "测试供应商",
  amountCents: 1_280_000,
  currency: "CNY",
  department: "采购部",
  project: "P001",
  summary: "采购材料",
  exceptionIds: [],
};

const testPostingRule = {
  id: "RULE-TEST",
  name: "测试采购规则",
  version: "1.0",
  enabled: true,
  posting: {
    debitAccountCode: "1403",
    debitAccountName: "原材料",
    creditAccountCode: "2202",
    creditAccountName: "应付账款",
  },
};

function createPurchaseVoucher(source, sequence = 1, rule = testPostingRule) {
  return createVoucherWithRule(source, sequence, rule);
}

test("金额转换使用整数分，避免二进制浮点误差", () => {
  assert.equal(toCents("12,800.35"), 1_280_035);
  assert.equal(toCents("-0.01"), -1);
  assert.throws(() => toCents("12.345"), /金额格式无效/);
});

test("CSV 解析支持引号中的逗号", () => {
  const rows = parseCsv('业务日期,供应商,含税金额,摘要\n2026-07-24,"上海,测试公司",12800.00,"采购,材料"');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].供应商, "上海,测试公司");
  assert.equal(rows[0].摘要, "采购,材料");
});

test("标准采购付款行可以转换为业务事项", () => {
  const result = eventFromRow({
    业务日期: "2026-07-24",
    供应商: "测试供应商",
    含税金额: "12800.00",
    审批单号: "SP-001",
    币别: "PHP",
    汇率: "0.0174",
  });
  assert.equal(result.amountCents, 1_280_000);
  assert.equal(result.status, "可生成");
  assert.equal(result.reference, "SP-001");
  assert.equal(result.currency, "PHP");
  assert.equal(result.exchangeRate, "0.0174");
  assert.equal(result.approvalStatus, "unknown");
  assert.equal(result.matchConfidence, null);
  assert.equal(result.company, "");
  assert.equal(result.ledger, "");
});

test("摘要模板使用用户可读字段标记而不是暴露正则表达式", () => {
  assert.equal(
    renderSummaryTemplate("员工话费充值 · {供应商/客商} · {业务日期}", event),
    "员工话费充值 · 测试供应商 · 2026-07-24",
  );
});

test("金蝶汇率按币别、业务日期和汇率类型匹配最新有效记录", () => {
  const masterData = [
    { category: "currency", code: "PRE001", name: "人民币", active: true },
    { category: "currency", code: "PRE013", name: "菲律宾比索", active: true },
    {
      category: "exchangeRate",
      code: "RATE-OLD",
      name: "汇率体系",
      active: true,
      sourceAttributes: {
        "FRATETYPEID.FNumber": "001",
        "FCyForID.FNumber": "PRE013",
        "FCyToID.FNumber": "PRE001",
        FBegDate: "2026-07-01",
        FEndDate: "2026-07-15",
        FExchangeRate: "0.0170",
        FDocumentStatus: "C",
        FForbidStatus: "A",
      },
    },
    {
      category: "exchangeRate",
      code: "RATE-CURRENT",
      name: "汇率体系",
      active: true,
      sourceAttributes: {
        "FRATETYPEID.FNumber": "001",
        "FCyForID.FNumber": "PRE013",
        "FCyToID.FNumber": "PRE001",
        FBegDate: "2026-07-16",
        FEndDate: "2026-07-31",
        FExchangeRate: "0.0174",
        FDocumentStatus: "C",
        FForbidStatus: "A",
      },
    },
  ];
  assert.equal(resolveKingdeeExchangeRate(masterData, {
    currency: "PHP",
    accountingDate: "2026-07-24",
    rateType: "001",
    baseCurrency: "PRE001",
  }), "0.0174");
});

test("多行凭证模板支持固定值、来源字段和简单计算并使用金蝶汇率", () => {
  const masterData = [
    { category: "currency", code: "PRE001", name: "人民币", active: true },
    { category: "currency", code: "PRE013", name: "菲律宾比索", active: true },
    {
      category: "exchangeRate",
      code: "RATE-1",
      name: "汇率体系",
      active: true,
      sourceAttributes: {
        "FRATETYPEID.FNumber": "001",
        "FCyForID.FNumber": "PRE013",
        "FCyToID.FNumber": "PRE001",
        FBegDate: "2026-07-01",
        FEndDate: "2026-07-31",
        FExchangeRate: "0.0174",
        FDocumentStatus: "C",
        FForbidStatus: "A",
      },
    },
  ];
  const source = {
    ...event,
    type: "员工薪酬",
    currency: "PHP",
    amountCents: 70_800,
    amountBreakdown: { grossCents: 70_800 },
    summary: "员工话费充值",
  };
  const rule = {
    id: "RULE-PHP",
    name: "菲律宾话费充值",
    version: "1.0",
    enabled: true,
    posting: {
      lines: [
        {
          summaryTemplate: "{摘要} · {供应商/客商}",
          accountCode: "6401.12",
          accountName: "主营业务成本_通讯成本",
          dimensions: {
            department: { mode: "field", field: "department" },
            project: { mode: "field", field: "project" },
            supplier: { mode: "field", field: "counterparty" },
          },
          currency: { mode: "fixed", value: "PRE013" },
          exchangeRateType: { mode: "fixed", value: "001" },
          exchangeRate: { mode: "field", field: "kingdeeExchangeRate" },
          originalAmount: { mode: "field", field: "amount" },
          debitAmount: { mode: "calculation", calculation: "originalTimesRate" },
          creditAmount: { mode: "fixed", value: "0" },
        },
        {
          summaryTemplate: "确认往来 · {供应商/客商}",
          accountCode: "2202.04.11",
          accountName: "应付账款_运营成本_通讯费",
          dimensions: {
            department: { mode: "calculation", calculation: "previousLineValue" },
            project: { mode: "calculation", calculation: "previousLineValue" },
            supplier: { mode: "field", field: "counterparty" },
          },
          currency: { mode: "calculation", calculation: "previousLineCurrency" },
          exchangeRateType: { mode: "calculation", calculation: "previousLineExchangeRateType" },
          exchangeRate: { mode: "calculation", calculation: "previousLineExchangeRate" },
          originalAmount: { mode: "fixed", value: "708.00" },
          debitAmount: { mode: "fixed", value: "0" },
          creditAmount: { mode: "calculation", calculation: "originalTimesRate" },
        },
      ],
    },
  };
  const voucher = createVoucherWithRule(source, 1, rule, {
    masterData,
    baseCurrency: "PRE001",
    exchangeRateType: "001",
  });
  assert.equal(voucher.lines.length, 2);
  assert.equal(voucher.lines[0].currency, "PRE013");
  assert.equal(voucher.lines[0].exchangeRate, "0.0174");
  assert.equal(voucher.lines[0].originalAmountCents, 70_800);
  assert.equal(voucher.lines[0].debitCents, 1_232);
  assert.equal(voucher.lines[1].creditCents, 1_232);
  assert.equal(validateVoucher(voucher).valid, true);
});

test("凭证场景可从审批数据处理字段读取当前有效科目", () => {
  const masterData = [{
    id: "MD-5602",
    category: "account",
    code: "5602",
    name: "管理费用",
    active: true,
  }];
  const source = {
    ...event,
    type: "采购付款",
    debitAccountMasterDataId: "MD-5602",
    debitAccountCode: "5602",
    debitAccountName: "管理费用",
  };
  const rule = {
    id: "RULE-APPROVAL-ACCOUNT",
    name: "审批科目付款",
    version: "1.0",
    enabled: true,
    posting: {
      lines: [
        {
          summaryTemplate: "{摘要}",
          accountCode: "",
          accountName: "",
          accountSource: { mode: "field", field: "debitAccount" },
          currency: { mode: "fixed", value: "CNY" },
          exchangeRateType: { mode: "fixed", value: "001" },
          exchangeRate: { mode: "fixed", value: "1" },
          originalAmount: { mode: "field", field: "amount" },
          debitAmount: { mode: "field", field: "amount" },
          creditAmount: { mode: "fixed", value: "0" },
        },
        {
          summaryTemplate: "银行付款",
          accountCode: "1002",
          accountName: "银行存款",
          accountSource: { mode: "fixed", field: "" },
          currency: { mode: "fixed", value: "CNY" },
          exchangeRateType: { mode: "fixed", value: "001" },
          exchangeRate: { mode: "fixed", value: "1" },
          originalAmount: { mode: "field", field: "amount" },
          debitAmount: { mode: "fixed", value: "0" },
          creditAmount: { mode: "field", field: "amount" },
        },
      ],
    },
  };
  const voucher = createVoucherWithRule(source, 1, rule, {
    masterData,
    sourceEventIds: ["BANK-1", "APR-1"],
  });

  assert.equal(voucher.lines[0].accountCode, "5602");
  assert.equal(voucher.lines[0].accountName, "管理费用");
  assert.equal(voucher.lines[1].accountCode, "1002");
  assert.deepEqual(voucher.sourceEventIds, ["BANK-1", "APR-1"]);
  assert.equal(voucher.validation.valid, true);
  assert.match(voucher.lines[0].explanation, /审批数据处理科目/);

  assert.throws(() => createVoucherWithRule(
    { ...source, debitAccountMasterDataId: "MD-OFF" },
    2,
    rule,
    { masterData },
  ), /不是当前有效科目主数据/);
});

test("场景选择的供应商辅助核算按目标账套唯一名称解析为编码", () => {
  const rule = {
    id: "RULE-DIMENSION",
    name: "供应商辅助核算",
    version: "1.0",
    enabled: true,
    posting: {
      lines: [
        {
          summaryTemplate: "{摘要}",
          accountCode: "1403",
          accountName: "原材料",
          dimensionBindings: [{
            key: "supplier",
            required: true,
            valueSpec: { mode: "field", field: "counterparty" },
          }],
          currency: { mode: "fixed", value: "PRE001" },
          exchangeRateType: { mode: "fixed", value: "001" },
          exchangeRate: { mode: "fixed", value: "1" },
          originalAmount: { mode: "field", field: "amount" },
          debitAmount: { mode: "calculation", calculation: "originalAmount" },
          creditAmount: { mode: "fixed", value: "0" },
        },
        {
          summaryTemplate: "确认往来",
          accountCode: "2202",
          accountName: "应付账款",
          dimensionBindings: [{
            key: "supplier",
            required: true,
            valueSpec: { mode: "field", field: "counterparty" },
          }],
          currency: { mode: "fixed", value: "PRE001" },
          exchangeRateType: { mode: "fixed", value: "001" },
          exchangeRate: { mode: "fixed", value: "1" },
          originalAmount: { mode: "field", field: "amount" },
          debitAmount: { mode: "fixed", value: "0" },
          creditAmount: { mode: "calculation", calculation: "originalAmount" },
        },
      ],
    },
  };
  const voucher = createVoucherWithRule(event, 1, rule, {
    connectorId: "kingdee-k3cloud",
    resolveDimensionMasterData: true,
    baseCurrency: "PRE001",
    masterData: [
      {
        id: "MD-SUP-1",
        sourceConnectorId: "kingdee-k3cloud",
        category: "dimensionSupplier",
        code: "SUP001",
        name: "测试供应商",
        active: true,
      },
    ],
  });
  assert.equal(voucher.lines[0].dimensions.supplier, "SUP001");
  assert.equal(voucher.lines[0].dimensionRefs.supplier.status, "matched");
  assert.equal(voucher.status, "待审核");
  assert.equal(validateVoucher(voucher).valid, true);
});

test("辅助核算同名多编码时不自动选择并阻止凭证确认", () => {
  const rule = {
    id: "RULE-AMBIGUOUS-DIMENSION",
    name: "同名供应商",
    version: "1.0",
    enabled: true,
    posting: {
      lines: [
        {
          summaryTemplate: "{摘要}",
          accountCode: "1403",
          accountName: "原材料",
          dimensions: { supplier: { mode: "field", field: "counterparty" } },
          requiredDimensions: ["supplier"],
          currency: { mode: "fixed", value: "PRE001" },
          exchangeRateType: { mode: "fixed", value: "001" },
          exchangeRate: { mode: "fixed", value: "1" },
          originalAmount: { mode: "field", field: "amount" },
          debitAmount: { mode: "calculation", calculation: "originalAmount" },
          creditAmount: { mode: "fixed", value: "0" },
        },
        {
          summaryTemplate: "确认往来",
          accountCode: "2202",
          accountName: "应付账款",
          dimensions: { supplier: { mode: "field", field: "counterparty" } },
          requiredDimensions: ["supplier"],
          currency: { mode: "fixed", value: "PRE001" },
          exchangeRateType: { mode: "fixed", value: "001" },
          exchangeRate: { mode: "fixed", value: "1" },
          originalAmount: { mode: "field", field: "amount" },
          debitAmount: { mode: "fixed", value: "0" },
          creditAmount: { mode: "calculation", calculation: "originalAmount" },
        },
      ],
    },
  };
  const voucher = createVoucherWithRule(event, 1, rule, {
    connectorId: "kingdee-k3cloud",
    resolveDimensionMasterData: true,
    baseCurrency: "PRE001",
    masterData: ["SUP001", "SUP002"].map((code) => ({
      id: `MD-${code}`,
      sourceConnectorId: "kingdee-k3cloud",
      category: "dimensionSupplier",
      code,
      name: "测试供应商",
      active: true,
    })),
  });
  assert.equal(voucher.lines[0].dimensionRefs.supplier.status, "ambiguous");
  assert.equal(voucher.status, "待处理");
  assert.match(validateVoucher(voucher).errors[0], /匹配不唯一/);
});

test("采购付款规则生成借贷平衡草稿并保留解释", () => {
  const voucher = createPurchaseVoucher(event, 1);
  const validation = validateVoucher(voucher);
  assert.equal(validation.valid, true);
  assert.equal(validation.debitCents, 1_280_000);
  assert.equal(validation.creditCents, 1_280_000);
  assert.match(voucher.lines[0].explanation, /测试采购规则/);
});

test("没有已启用规则时不使用默认借贷科目", () => {
  assert.throws(
    () => createVoucherWithRule(event, 1, null),
    /未命中已启用且完整的凭证场景/,
  );
});

test("单行同时含借贷金额时阻止确认", () => {
  const voucher = createPurchaseVoucher(event, 1);
  voucher.lines[0].creditCents = 100;
  const validation = validateVoucher(voucher);
  assert.equal(validation.valid, false);
  assert.match(validation.errors[0], /不能同时包含/);
});

test("同一凭证输入生成稳定幂等键", () => {
  const voucher = createPurchaseVoucher(event, 1);
  assert.equal(buildIdempotencyKey(voucher), buildIdempotencyKey({ ...voucher, id: "OTHER" }));
});

test("本地账簿只汇总已确认和已推送凭证", () => {
  const draft = createPurchaseVoucher(event, 1);
  const approved = createPurchaseVoucher({ ...event, id: "EV-2" }, 2);
  approved.status = "已确认";
  const ledger = buildLedger([draft, approved]);
  assert.equal(ledger.length, 2);
  assert.equal(ledger.find((row) => row.accountCode === "1403").debitCents, 1_280_000);
});

test("人工编辑凭证后重新校验并记录操作者", () => {
  const voucher = createPurchaseVoucher(event, 1);
  const lines = voucher.lines.map((line) => ({ ...line, summary: `${line.summary}（已核对）` }));
  const updated = applyVoucherLineEdits(
    voucher,
    lines,
    "复核员",
    "根据已确认的原始资料修正摘要",
    "2026-07-25T00:00:00.000Z",
  );
  assert.equal(updated.status, "待审核");
  assert.equal(updated.editedBy, "复核员");
  assert.equal(updated.validation.valid, true);
  assert.match(updated.lines[0].explanation, /复核员/);
  assert.equal(updated.editHistory[0].reason, "根据已确认的原始资料修正摘要");
});

test("人工编辑造成借贷不平时拒绝保存", () => {
  const voucher = createPurchaseVoucher(event, 1);
  const lines = voucher.lines.map((line) => ({ ...line }));
  lines[0].debitCents -= 100;
  assert.throws(() => applyVoucherLineEdits(voucher, lines, "复核员", "修正金额"), /借贷不平/);
});

test("已确认凭证修改后回到待审核并保留修改前后差异", () => {
  const voucher = createPurchaseVoucher(event, 1);
  voucher.status = "已确认";
  const lines = voucher.lines.map((line) => ({ ...line }));
  lines[0].accountCode = "1405";
  lines[0].accountName = "库存商品";
  const updated = applyVoucherLineEdits(voucher, lines, "复核员", "改用库存商品科目");
  assert.equal(updated.status, "待审核");
  assert.equal(updated.editHistory[0].previousStatus, "已确认");
  assert.equal(updated.editHistory[0].before[0].accountCode, "1403");
  assert.equal(updated.editHistory[0].after[0].accountCode, "1405");
});

test("必填供应商辅助核算缺失时阻止确认", () => {
  const voucher = createPurchaseVoucher(event, 1);
  voucher.lines[1].dimensions.supplier = null;
  const validation = validateVoucher(voucher);
  assert.equal(validation.valid, false);
  assert.match(validation.errors[0], /供应商/);
});

test("批量确认只返回借贷平衡且无阻断异常的草稿", () => {
  const ready = createPurchaseVoucher(event, 1);
  const blockedEvent = { ...event, id: "EV-2", exceptionIds: ["EX-2"] };
  const blocked = createPurchaseVoucher(blockedEvent, 2);
  blocked.status = "待审核";
  const result = eligibleForBatchConfirmation({
    events: [event, blockedEvent],
    vouchers: [ready, blocked],
    exceptions: [{ id: "EX-2", status: "待处理" }],
  });
  assert.deepEqual(result.map((voucher) => voucher.id), [ready.id]);
});

test("高优先级结构化规则参与分录生成并保留版本依据", () => {
  const rules = [
    {
      id: "RULE-GENERAL",
      name: "采购通用规则",
      priority: 50,
      version: "1.0",
      enabled: true,
      match: { businessType: "采购付款", counterparty: "" },
      posting: {
        debitAccountCode: "1403",
        debitAccountName: "原材料",
        creditAccountCode: "2202",
        creditAccountName: "应付账款",
      },
    },
    {
      id: "RULE-SUPPLIER",
      name: "指定供应商库存商品规则",
      priority: 90,
      version: "2.1",
      enabled: true,
      match: { businessType: "采购付款", counterparty: "测试供应商" },
      posting: {
        debitAccountCode: "1405",
        debitAccountName: "库存商品",
        creditAccountCode: "2202",
        creditAccountName: "应付账款",
      },
    },
  ];
  const typedEvent = { ...event, type: "采购付款" };
  const selected = selectPostingRule(rules, typedEvent);
  const voucher = createPurchaseVoucher(typedEvent, 1, selected);
  assert.equal(selected.id, "RULE-SUPPLIER");
  assert.equal(voucher.lines[0].accountCode, "1405");
  assert.equal(voucher.ruleVersion, "指定供应商库存商品规则 v2.1");
  assert.equal(voucher.appliedRuleId, "RULE-SUPPLIER");
});

test("部分付款由人工确认后拆成已结算事项和剩余待匹配事项", () => {
  const source = {
    ...event,
    type: "采购付款",
    reference: "SP-100",
    businessKey: "business-key",
    sourceDocumentIds: ["DOC-ORDER", "DOC-PAYMENT"],
    sourceRecords: [{ amountCents: 1_280_000 }, { amountCents: 1_180_000 }],
    matchExplanation: [],
  };
  const { settledEvent, residualEvent } = splitEventForPartialPayment(source, 1_180_000, "T1");
  assert.equal(settledEvent.amountCents, 1_180_000);
  assert.equal(residualEvent.amountCents, 100_000);
  assert.equal(residualEvent.derivedFromEventId, source.id);
  assert.equal(residualEvent.status, "待处理");
  assert.equal(settledEvent.allocationHistory[0].originalCents, 1_280_000);
});

test("付款额高于事项金额时可保留原事项并拆出差额待匹配", () => {
  const source = {
    ...event,
    type: "采购付款",
    reference: "SP-OVER",
    sourceDocumentIds: ["DOC-ORDER", "DOC-PAYMENT"],
    sourceRecords: [{ amountCents: 1_280_000 }, { amountCents: 1_380_000 }],
    matchExplanation: [],
  };
  const { settledEvent, residualEvent } = splitEventForPartialPayment(
    source,
    1_280_000,
    "T2",
    1_380_000,
  );
  assert.equal(settledEvent.amountCents, 1_280_000);
  assert.equal(residualEvent.amountCents, 100_000);
  assert.equal(settledEvent.allocationHistory[0].allocationTotalCents, 1_380_000);
});

test("凭证人工修改可生成完整但待启用的结构化规则", () => {
  const sourceEvent = { ...event, type: "采购付款" };
  const voucher = createPurchaseVoucher(sourceEvent, 1);
  voucher.lines[0].accountCode = "1405";
  voucher.lines[0].accountName = "库存商品";
  const rule = createRuleFromVoucherEdit(voucher, sourceEvent, "复核员", "RULE-EDIT-1", "2026-07-24T00:00:00Z");
  assert.equal(rule.enabled, false);
  assert.equal(rule.status, "待启用");
  assert.equal(rule.match.businessType, "采购付款");
  assert.equal(rule.posting.debitAccountCode, "1405");
  assert.equal(rule.posting.creditAccountCode, "2202");
  assert.equal(rule.sourceVoucherId, voucher.id);
});

test("修改规则创建新版本并保留旧规则身份", () => {
  const original = {
    id: "RULE-1",
    name: "采购规则",
    version: "1.2",
    enabled: true,
    priority: 80,
    match: { businessType: "采购付款" },
    posting: { debitAccountCode: "1403", creditAccountCode: "2202" },
  };
  const next = createRuleVersion(
    original,
    { priority: 90 },
    "规则管理员",
    "RULE-2",
    "2026-07-24T00:00:00Z",
  );
  assert.equal(next.version, "1.3");
  assert.equal(next.lineageId, "RULE-1");
  assert.equal(next.supersedesRuleId, "RULE-1");
  assert.equal(next.priority, 90);
  assert.equal(original.version, "1.2");
  assert.equal(original.enabled, true);
});

test("十万条本地记录常用筛选在两秒内返回有界结果", () => {
  const records = Array.from({ length: 100_000 }, (_, index) => ({
    reference: `SP-${String(index).padStart(6, "0")}`,
    counterparty: index === 99_999 ? "目标供应商" : `供应商-${index % 500}`,
    status: index % 2 ? "可生成" : "已完成",
    amountCents: index * 100,
  }));
  const started = Date.now();
  const result = filterLocalRecords(
    records,
    "目标供应商",
    ["reference", "counterparty", "status", "amountCents"],
    100,
  );
  const elapsed = Date.now() - started;
  assert.equal(result.length, 1);
  assert.equal(result[0].reference, "SP-099999");
  assert.ok(elapsed < 2_000, `筛选耗时 ${elapsed}ms`);
});
