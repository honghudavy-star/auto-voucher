const roundPattern = /^-?\d+(?:\.\d{0,2})?$/;

export const AUXILIARY_DIMENSION_CATALOG = Object.freeze([
  { key: "department", label: "部门", masterCategory: "dimensionDepartment", defaultField: "department" },
  { key: "project", label: "项目", masterCategory: "project", defaultField: "project" },
  { key: "supplier", label: "供应商", masterCategory: "dimensionSupplier", defaultField: "counterparty" },
  { key: "customer", label: "客户", masterCategory: "dimensionCustomer", defaultField: "counterparty" },
  { key: "employee", label: "员工", masterCategory: "dimensionEmployee", defaultField: "" },
  { key: "material", label: "物料", masterCategory: "dimensionMaterial", defaultField: "" },
  { key: "expense", label: "费用项目", masterCategory: "dimensionExpense", defaultField: "" },
  { key: "organization", label: "组织机构", masterCategory: "dimensionOrganization", defaultField: "" },
  { key: "bank", label: "银行", masterCategory: "dimensionBank", defaultField: "" },
  { key: "bankAccount", label: "银行账号", masterCategory: "dimensionBankAccount", defaultField: "" },
  {
    key: "otherCounterparty",
    label: "其他往来",
    masterCategory: "dimensionOtherCounterparty",
    defaultField: "counterparty",
  },
  { key: "serviceType", label: "服务类型", masterCategory: "dimensionServiceType", defaultField: "" },
  { key: "unit", label: "Unit", masterCategory: "dimensionUnit", defaultField: "" },
  { key: "region", label: "入账地区", masterCategory: "dimensionRegion", defaultField: "" },
  { key: "oldProject", label: "旧项目", masterCategory: "dimensionOldProject", defaultField: "project" },
  { key: "newProject", label: "新项目", masterCategory: "dimensionNewProject", defaultField: "project" },
]);

const auxiliaryDimensionByKey = new Map(
  AUXILIARY_DIMENSION_CATALOG.map((item) => [item.key, item]),
);

export function normalizeDimensionBindings(line) {
  const required = new Set(line?.requiredDimensions || []);
  const source = Array.isArray(line?.dimensionBindings)
    ? line.dimensionBindings
    : Object.entries(line?.dimensions || {}).map(([key, valueSpec]) => ({
      key,
      valueSpec,
      required: required.has(key),
    }));
  const seen = new Set();
  return source.flatMap((binding) => {
    const key = String(binding?.key || "").trim();
    const definition = auxiliaryDimensionByKey.get(key);
    if (!definition || seen.has(key)) return [];
    seen.add(key);
    return [{
      key,
      label: definition.label,
      masterCategory: definition.masterCategory,
      required: binding.required === true || required.has(key),
      valueSpec: binding.valueSpec ?? line?.dimensions?.[key] ?? "",
    }];
  });
}

export function toCents(value) {
  const normalized = String(value ?? "0").replace(/[,\s¥￥]/g, "");
  if (!roundPattern.test(normalized)) {
    throw new Error(`金额格式无效：${value}`);
  }
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [yuan, fraction = ""] = unsigned.split(".");
  const cents = Number.parseInt(yuan, 10) * 100 + Number.parseInt(fraction.padEnd(2, "0"), 10);
  return negative ? -cents : cents;
}

export function formatMoney(cents, currency = "CNY") {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

const fieldAliases = {
  date: ["业务日期", "日期", "date", "business_date"],
  counterparty: ["供应商", "客户", "客商", "counterparty", "vendor"],
  amount: ["金额", "含税金额", "付款金额", "amount", "gross_amount"],
  currency: ["币别", "币种", "currency", "currency_code"],
  exchangeRate: ["汇率", "记账汇率", "exchange_rate", "rate"],
  reference: ["单据号", "审批单号", "订单号", "reference", "external_id"],
  department: ["部门", "department"],
  project: ["项目", "project"],
  summary: ["摘要", "业务摘要", "summary"],
};

function pick(row, keys) {
  const key = keys.find((candidate) => Object.hasOwn(row, candidate));
  return key ? row[key] : "";
}

export function eventFromRow(row, sequence = 1) {
  const amount = pick(row, fieldAliases.amount);
  const counterparty = pick(row, fieldAliases.counterparty);
  if (!amount || !counterparty) {
    throw new Error("缺少“金额”或“供应商/客商”字段");
  }
  const amountCents = toCents(amount);
  const date = pick(row, fieldAliases.date) || new Date().toISOString().slice(0, 10);
  const reference = pick(row, fieldAliases.reference) || `IMP-${String(sequence).padStart(4, "0")}`;

  return {
    id: `EV-${Date.now()}-${sequence}`,
    reference,
    type: pick(row, ["业务类型", "business_type", "type"]),
    company: pick(row, ["公司", "主体", "company", "legal_entity"]),
    ledger: pick(row, ["账簿", "账套", "ledger", "book"]),
    date,
    counterparty,
    amountCents,
    amountBreakdown: {
      grossCents: amountCents,
      netCents: pick(row, ["不含税金额", "net_amount"]) ? toCents(pick(row, ["不含税金额", "net_amount"])) : null,
      taxCents: pick(row, ["税额", "tax_amount"]) ? toCents(pick(row, ["税额", "tax_amount"])) : null,
      paymentCents: pick(row, ["付款金额", "实付金额", "payment_amount"])
        ? toCents(pick(row, ["付款金额", "实付金额", "payment_amount"]))
        : null,
    },
    currency: pick(row, fieldAliases.currency) || "CNY",
    exchangeRate: pick(row, fieldAliases.exchangeRate) || "",
    department: pick(row, fieldAliases.department),
    project: pick(row, fieldAliases.project),
    summary: pick(row, fieldAliases.summary) || counterparty,
    approvalStatus: "unknown",
    sourceVerified: false,
    financeReviewed: false,
    pushAllowed: false,
    matchConfidence: null,
    sourceDocumentIds: [],
    exceptionIds: [],
    status: "可生成",
  };
}

export function filterLocalRecords(records, query, fields, limit = 100) {
  const needle = String(query || "").trim().toLowerCase();
  const results = [];
  for (const record of records || []) {
    const matches = !needle || fields.some((field) =>
      String(record?.[field] ?? "").toLowerCase().includes(needle));
    if (matches) results.push(record);
    if (results.length >= limit) break;
  }
  return results;
}

export function validateVoucher(voucher) {
  const errors = [];
  let debit = 0;
  let credit = 0;
  voucher.lines.forEach((line, index) => {
    if (line.debitCents && line.creditCents) {
      errors.push(`第 ${index + 1} 行不能同时包含借方和贷方金额`);
    }
    if (!line.accountCode) errors.push(`第 ${index + 1} 行缺少会计科目`);
    if (!String(line.summary || "").trim()) errors.push(`第 ${index + 1} 行缺少摘要`);
    if (line.currency && (!line.exchangeRate || Number(line.exchangeRate) <= 0)) {
      errors.push(`第 ${index + 1} 行缺少有效汇率`);
    }
    if (
      Number.isInteger(line.originalAmountCents)
      && line.originalAmountCents !== 0
      && !(line.debitCents || line.creditCents)
    ) {
      errors.push(`第 ${index + 1} 行原币金额没有对应借方或贷方金额`);
    }
    (line.requiredDimensions || []).forEach((dimension) => {
      if (!line.dimensions?.[dimension]) {
        const label = auxiliaryDimensionByKey.get(dimension)?.label || dimension;
        errors.push(`第 ${index + 1} 行缺少必填辅助核算：${label}`);
      }
    });
    Object.entries(line.dimensionRefs || {}).forEach(([dimension, reference]) => {
      if (!reference || ["matched", "unverified"].includes(reference.status)) return;
      const label = auxiliaryDimensionByKey.get(dimension)?.label || dimension;
      const reasons = {
        missing: "目标账套不存在",
        ambiguous: "名称匹配不唯一",
        unsynced: "目标主数据尚未同步",
      };
      errors.push(
        `第 ${index + 1} 行辅助核算${label}校验失败：${reasons[reference.status] || "无法确认"}`,
      );
    });
    debit += line.debitCents || 0;
    credit += line.creditCents || 0;
  });
  if (debit !== credit) errors.push(`借贷不平，差额 ${formatMoney(Math.abs(debit - credit))}`);
  return {
    valid: errors.length === 0,
    errors,
    debitCents: debit,
    creditCents: credit,
  };
}

const summaryTemplateFields = {
  业务类型: "type",
  businessType: "type",
  单据号: "reference",
  reference: "reference",
  "供应商/客商": "counterparty",
  供应商: "counterparty",
  客商: "counterparty",
  counterparty: "counterparty",
  公司: "company",
  company: "company",
  账簿: "ledger",
  ledger: "ledger",
  业务日期: "date",
  date: "date",
  部门: "department",
  department: "department",
  项目: "project",
  project: "project",
  摘要: "summary",
  summary: "summary",
  币别: "currency",
  currency: "currency",
};

const currencyNameAliases = {
  CNY: ["人民币", "RMB"],
  USD: ["美元", "美金"],
  EUR: ["欧元"],
  GBP: ["英镑"],
  JPY: ["日元"],
  HKD: ["港币", "港元"],
  PHP: ["菲律宾比索"],
};

function eventFieldValue(event, field) {
  const eventKey = summaryTemplateFields[field] || field;
  const amountFields = {
    amount: event.amountCents,
    grossAmount: event.amountBreakdown?.grossCents ?? event.amountCents,
    netAmount: event.amountBreakdown?.netCents,
    taxAmount: event.amountBreakdown?.taxCents,
    paymentAmount: event.amountBreakdown?.paymentCents,
  };
  if (Object.hasOwn(amountFields, field)) return amountFields[field];
  if (field === "exchangeRate") return event.exchangeRate || "";
  return event?.[eventKey] ?? "";
}

export function renderSummaryTemplate(template, event) {
  return String(template || "")
    .replace(/\{([^{}]+)\}/g, (_match, field) => String(eventFieldValue(event, field.trim()) ?? ""))
    .replace(/\s*·\s*(?=·|$)/g, "")
    .trim();
}

function decimalFraction(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`汇率格式无效：${value}`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || "0");
  if (numerator <= 0n) throw new Error("汇率必须大于零");
  return { numerator, denominator };
}

function divideAndRound(numerator, denominator) {
  if (denominator <= 0n) throw new Error("计算分母必须大于零");
  return (numerator + denominator / 2n) / denominator;
}

function calculateLocalCents(originalCents, exchangeRate, operation = "multiply") {
  const { numerator, denominator } = decimalFraction(exchangeRate);
  const negative = originalCents < 0;
  const absolute = BigInt(Math.abs(originalCents));
  const result = operation === "divide"
    ? divideAndRound(absolute * denominator, numerator)
    : divideAndRound(absolute * numerator, denominator);
  const signed = negative ? -result : result;
  const converted = Number(signed);
  if (!Number.isSafeInteger(converted)) throw new Error("金额换算结果超出安全范围");
  return converted;
}

function normalizedDate(value) {
  return String(value || "").slice(0, 10);
}

function activeMasterData(masterData, category) {
  return (masterData || []).filter((item) =>
    item.category === category && item.active !== false && item.status !== "停用");
}

export function resolveCurrencyCode(value, masterData = [], baseCurrency = "") {
  const raw = String(value || "").trim();
  if (!raw) return String(baseCurrency || "").trim();
  const upper = raw.toUpperCase();
  const aliases = new Set([raw, upper, ...(currencyNameAliases[upper] || [])]);
  const match = activeMasterData(masterData, "currency").find((item) =>
    aliases.has(String(item.code || "").trim())
    || aliases.has(String(item.name || "").trim()));
  if (match) return String(match.code || raw);
  if (upper === "CNY" && baseCurrency === "PRE001") return baseCurrency;
  return raw;
}

export function resolveKingdeeExchangeRate(
  masterData,
  {
    currency,
    accountingDate,
    rateType = "",
    baseCurrency = "",
  },
) {
  const sourceCurrency = resolveCurrencyCode(currency, masterData, baseCurrency);
  const targetCurrency = resolveCurrencyCode(baseCurrency, masterData, baseCurrency);
  if (sourceCurrency && targetCurrency && sourceCurrency === targetCurrency) return "1";
  const date = normalizedDate(accountingDate);
  const matching = activeMasterData(masterData, "exchangeRate")
    .filter((item) => {
      const attributes = item.sourceAttributes || {};
      const source = String(attributes["FCyForID.FNumber"] || "").trim();
      const target = String(attributes["FCyToID.FNumber"] || "").trim();
      const typeNumber = String(attributes["FRATETYPEID.FNumber"] || "").trim();
      const typeName = String(item.name || attributes["FRATETYPEID.FName"] || "").trim();
      const begin = normalizedDate(attributes.FBegDate);
      const end = normalizedDate(attributes.FEndDate);
      const documentStatus = String(attributes.FDocumentStatus || "").trim();
      const forbidStatus = String(attributes.FForbidStatus || "").trim();
      return source === sourceCurrency
        && (!targetCurrency || target === targetCurrency)
        && (!rateType || rateType === typeNumber || rateType === typeName)
        && (!date || !begin || begin <= date)
        && (!date || !end || end >= date)
        && (!documentStatus || documentStatus === "C")
        && (!forbidStatus || forbidStatus === "A");
    })
    .sort((left, right) =>
      normalizedDate(right.sourceAttributes?.FBegDate)
        .localeCompare(normalizedDate(left.sourceAttributes?.FBegDate)));
  const rate = matching[0]?.sourceAttributes?.FExchangeRate;
  if (rate === "" || rate == null) return "";
  return String(rate);
}

function normalizedSpec(spec, fallback = {}) {
  if (spec && typeof spec === "object") {
    return {
      mode: spec.mode || fallback.mode || "fixed",
      value: spec.value ?? fallback.value ?? "",
      field: spec.field || fallback.field || "",
      calculation: spec.calculation || fallback.calculation || "",
    };
  }
  return {
    mode: fallback.mode || "fixed",
    value: spec ?? fallback.value ?? "",
    field: fallback.field || "",
    calculation: fallback.calculation || "",
  };
}

function resolveTextSpec(spec, event, context, previousLine, dimensionName = "") {
  const source = normalizedSpec(spec);
  if (source.mode === "fixed") return String(source.value || "");
  if (source.mode === "field") return String(eventFieldValue(event, source.field) ?? "");
  if (source.calculation === "baseCurrency") return String(context.baseCurrency || "");
  if (source.calculation === "defaultRateType") return String(context.defaultRateType || "");
  if (source.calculation === "previousLineCurrency") return String(previousLine?.currency || "");
  if (source.calculation === "previousLineExchangeRateType") {
    return String(previousLine?.exchangeRateType || "");
  }
  if (source.calculation === "previousLineValue") {
    return String(previousLine?.dimensions?.[dimensionName] || "");
  }
  return "";
}

function resolveDimensionBindings(template, event, context, previousLine) {
  const dimensions = {};
  const dimensionRefs = {};
  const requiredDimensions = [];
  normalizeDimensionBindings(template).forEach((binding) => {
    const input = resolveTextSpec(
      binding.valueSpec,
      event,
      context,
      previousLine,
      binding.key,
    ).trim();
    if (binding.required) requiredDimensions.push(binding.key);
    if (!input) {
      dimensions[binding.key] = null;
      return;
    }
    const reference = {
      input,
      code: "",
      name: "",
      label: binding.label,
      masterCategory: binding.masterCategory,
      status: "unverified",
    };
    if (context.resolveDimensionMasterData) {
      const active = context.masterData.filter((item) =>
        item?.active !== false
        && item?.sourceConnectorId === context.connectorId
        && item?.category === binding.masterCategory);
      const normalizedInput = input.toLocaleLowerCase("zh-CN");
      const codeMatches = active.filter((item) =>
        String(item.code || "").trim().toLocaleLowerCase("zh-CN") === normalizedInput);
      const nameMatches = active.filter((item) =>
        String(item.name || "").trim().toLocaleLowerCase("zh-CN") === normalizedInput);
      const matches = codeMatches.length ? codeMatches : nameMatches;
      if (!active.length) reference.status = "unsynced";
      else if (!matches.length) reference.status = "missing";
      else if (matches.length > 1) reference.status = "ambiguous";
      else {
        reference.status = "matched";
        reference.code = String(matches[0].code || "").trim();
        reference.name = String(matches[0].name || "").trim();
        reference.masterDataId = matches[0].id || "";
        dimensions[binding.key] = reference.code;
      }
    }
    dimensions[binding.key] ??= input;
    dimensionRefs[binding.key] = reference;
  });
  return { dimensions, dimensionRefs, requiredDimensions };
}

function resolveOriginalAmountSpec(spec, event) {
  const source = normalizedSpec(spec, { mode: "field", field: "amount" });
  if (source.mode === "fixed") return toCents(source.value || "0");
  if (source.mode === "field") {
    const amount = eventFieldValue(event, source.field);
    if (!Number.isInteger(amount)) throw new Error(`来源金额字段没有有效值：${source.field}`);
    return amount;
  }
  if (source.calculation === "netPlusTax") {
    const net = eventFieldValue(event, "netAmount");
    const tax = eventFieldValue(event, "taxAmount");
    if (!Number.isInteger(net) || !Number.isInteger(tax)) {
      throw new Error("不含税金额或税额缺少有效值");
    }
    return net + tax;
  }
  if (source.calculation === "grossMinusTax") {
    const gross = eventFieldValue(event, "grossAmount");
    const tax = eventFieldValue(event, "taxAmount");
    if (!Number.isInteger(gross) || !Number.isInteger(tax)) {
      throw new Error("含税金额或税额缺少有效值");
    }
    return gross - tax;
  }
  throw new Error("原币金额的简单计算未配置");
}

function inverseDecimal(value) {
  const { numerator, denominator } = decimalFraction(value);
  const scaled = divideAndRound(denominator * 1_000_000_000_000n, numerator);
  return `${scaled / 1_000_000_000_000n}.${String(scaled % 1_000_000_000_000n).padStart(12, "0")}`
    .replace(/\.?0+$/, "");
}

function resolveExchangeRateSpec(spec, event, context, currency, rateType, previousLine) {
  if (currency && context.baseCurrency && currency === context.baseCurrency) return "1";
  const source = normalizedSpec(spec, { mode: "field", field: "kingdeeExchangeRate" });
  const kingdeeRate = () => resolveKingdeeExchangeRate(context.masterData, {
    currency,
    accountingDate: event.date,
    rateType,
    baseCurrency: context.baseCurrency,
  });
  let value = "";
  if (source.mode === "fixed") value = source.value;
  if (source.mode === "field") {
    value = source.field === "kingdeeExchangeRate"
      ? kingdeeRate()
      : eventFieldValue(event, source.field);
  }
  if (source.mode === "calculation") {
    if (source.calculation === "rateOne") value = "1";
    if (source.calculation === "previousLineExchangeRate") value = previousLine?.exchangeRate || "";
    if (source.calculation === "inverseKingdeeRate") {
      const directRate = kingdeeRate();
      value = directRate ? inverseDecimal(directRate) : "";
    }
  }
  if (!String(value || "").trim()) {
    throw new Error(`未匹配到 ${currency || "当前币别"} 在 ${event.date} 的金蝶汇率`);
  }
  decimalFraction(value);
  return String(value);
}

function resolveLocalAmountSpec(spec, event, originalAmountCents, exchangeRate) {
  const source = normalizedSpec(spec, { mode: "fixed", value: "0" });
  if (source.mode === "fixed") return toCents(source.value || "0");
  if (source.mode === "field") {
    const amount = eventFieldValue(event, source.field);
    if (!Number.isInteger(amount)) throw new Error(`来源金额字段没有有效值：${source.field}`);
    return amount;
  }
  if (source.calculation === "originalAmount") return originalAmountCents;
  if (source.calculation === "originalTimesRate") {
    return calculateLocalCents(originalAmountCents, exchangeRate, "multiply");
  }
  if (source.calculation === "originalDivideRate") {
    return calculateLocalCents(originalAmountCents, exchangeRate, "divide");
  }
  throw new Error("借贷金额的简单计算未配置");
}

function amountSpecActive(spec) {
  if (!spec || typeof spec !== "object") return false;
  if (spec.mode === "fixed") {
    try {
      return toCents(spec.value || "0") !== 0;
    } catch {
      return false;
    }
  }
  return Boolean(spec.field || spec.calculation);
}

function accountSourceComplete(line) {
  const source = line?.accountSource;
  if (source?.mode === "field") return source.field === "debitAccount";
  return Boolean(String(line?.accountCode || "").trim());
}

export function postingRuleComplete(rule) {
  const lines = rule?.posting?.lines;
  if (Array.isArray(lines) && lines.length) {
    return lines.every(accountSourceComplete)
      && lines.some((line) => amountSpecActive(line.debitAmount))
      && lines.some((line) => amountSpecActive(line.creditAmount))
      && lines.every((line) =>
        !(amountSpecActive(line.debitAmount) && amountSpecActive(line.creditAmount)));
  }
  return Boolean(rule?.posting?.debitAccountCode && rule?.posting?.creditAccountCode);
}

export function ruleMatchesEvent(rule, event) {
  if (!rule?.enabled) return false;
  const match = rule.match || {};
  if (match.businessType && match.businessType !== event.type) return false;
  if (match.counterparty && match.counterparty !== event.counterparty) return false;
  return Boolean(match.businessType || match.counterparty);
}

export function selectPostingRule(rules, event) {
  return [...(rules || [])]
    .filter((rule) => ruleMatchesEvent(rule, event) && postingRuleComplete(rule))
    .sort((left, right) => (right.priority || 0) - (left.priority || 0))[0] || null;
}

export function matchingPostingRules(rules, event) {
  return [...(rules || [])]
    .filter((rule) => ruleMatchesEvent(rule, event) && postingRuleComplete(rule))
    .sort((left, right) => (right.priority || 0) - (left.priority || 0));
}

function bumpRuleVersion(version) {
  const [major, minor] = String(version || "1.0").split(".").map(Number);
  return `${Number.isInteger(major) ? major : 1}.${Number.isInteger(minor) ? minor + 1 : 1}`;
}

export function createRuleVersion(rule, changes, operator, id, createdAt = new Date().toISOString()) {
  if (!rule?.id) throw new Error("原规则不存在");
  const version = bumpRuleVersion(rule.version);
  return {
    ...rule,
    ...changes,
    id,
    lineageId: rule.lineageId || rule.id,
    version,
    enabled: false,
    status: "待启用",
    supersedesRuleId: rule.id,
    createdBy: operator || "本机操作者",
    createdAt,
  };
}

export function createRuleFromVoucherEdit(
  voucher,
  event,
  operator,
  id,
  createdAt = new Date().toISOString(),
) {
  const debit = voucher.lines.find((line) => (line.debitCents || 0) > 0);
  const credit = voucher.lines.find((line) => (line.creditCents || 0) > 0);
  if (!debit?.accountCode || !credit?.accountCode) {
    throw new Error("修改后的凭证缺少可复用的借贷科目");
  }
  const businessType = event?.type || "采购付款";
  const counterparty = event?.counterparty || "";
  return {
    id,
    lineageId: id,
    name: `${voucher.summary} · 人工修正规则`,
    priority: 70,
    version: "1.0",
    enabled: false,
    status: "待启用",
    condition: `业务类型 = ${businessType}${counterparty ? `；供应商/客商 = ${counterparty}` : ""}`,
    action: `借：${debit.accountCode} ${debit.accountName}；贷：${credit.accountCode} ${credit.accountName}`,
    match: { businessType, counterparty },
    posting: {
      debitAccountCode: debit.accountCode,
      debitAccountName: debit.accountName,
      creditAccountCode: credit.accountCode,
      creditAccountName: credit.accountName,
    },
    sourceVoucherId: voucher.id,
    createdBy: operator || "本机操作者",
    createdAt,
  };
}

export function createPurchaseVoucher(event, sequence = 1, rule = null, options = {}) {
  if (!rule?.enabled || !postingRuleComplete(rule)) {
    throw new Error("未命中已启用且完整的凭证场景；请先创建待配置事项并完成人工确认");
  }
  const posting = rule.posting;
  const debitAccountCode = posting.debitAccountCode;
  const debitAccountName = posting.debitAccountName || "";
  const creditAccountCode = posting.creditAccountCode;
  const creditAccountName = posting.creditAccountName || "";
  const ruleVersion = `${rule.name} v${rule.version}`;
  const context = {
    masterData: options.masterData || [],
    baseCurrency: String(options.baseCurrency || ""),
    defaultRateType: String(options.exchangeRateType || "001"),
    connectorId: String(options.connectorId || ""),
    resolveDimensionMasterData: options.resolveDimensionMasterData === true,
  };
  const configuredLines = Array.isArray(posting.lines) && posting.lines.length
    ? posting.lines
    : null;
  const lines = configuredLines
    ? (() => {
      const generated = [];
      configuredLines.forEach((template, index) => {
        const previousLine = generated[index - 1];
      const accountSource = template.accountSource || { mode: "fixed" };
      let accountCode = String(template.accountCode || "");
      let accountName = String(template.accountName || "");
      let accountExplanation = `${accountCode} ${accountName}`.trim();
      const accountSourceFields = [];
      if (accountSource.mode === "field") {
        if (accountSource.field !== "debitAccount") {
          throw new Error("科目来源字段未配置");
        }
        const selectedAccount = context.masterData.find((item) =>
          item.category === "account"
          && item.active !== false
          && item.status !== "停用"
          && (
            event.debitAccountMasterDataId
              ? item.id === event.debitAccountMasterDataId
              : item.code === event.debitAccountCode
          ));
        if (!selectedAccount) {
          throw new Error("审批数据处理中的科目不是当前有效科目主数据");
        }
        accountCode = String(selectedAccount.code || "");
        accountName = String(selectedAccount.name || "");
        accountExplanation = `审批数据处理科目 ${accountCode} ${accountName}`;
        accountSourceFields.push("审批数据处理.科目");
      }
      const currency = resolveCurrencyCode(
        resolveTextSpec(template.currency, event, context, previousLine),
        context.masterData,
        context.baseCurrency,
      );
      const exchangeRateType = resolveTextSpec(
        template.exchangeRateType || { mode: "fixed", value: context.defaultRateType },
        event,
        context,
        previousLine,
      ) || context.defaultRateType;
      const exchangeRate = resolveExchangeRateSpec(
        template.exchangeRate,
        event,
        context,
        currency,
        exchangeRateType,
        previousLine,
      );
      const originalAmountCents = resolveOriginalAmountSpec(template.originalAmount, event);
      const dimensionResolution = resolveDimensionBindings(
        template,
        event,
        context,
        previousLine,
      );
        generated.push({
        lineNo: index + 1,
        summary: renderSummaryTemplate(template.summaryTemplate || "{摘要}", event),
        accountCode,
        accountName,
        currency,
        exchangeRateType,
        exchangeRate,
        originalAmountCents,
        debitCents: resolveLocalAmountSpec(
          template.debitAmount,
          event,
          originalAmountCents,
          exchangeRate,
        ),
        creditCents: resolveLocalAmountSpec(
          template.creditAmount,
          event,
          originalAmountCents,
          exchangeRate,
        ),
        ...dimensionResolution,
        explanation: `命中 ${ruleVersion}：第 ${index + 1} 行使用${accountExplanation}`,
        sourceFields: [...new Set([
          ...(template.sourceFields || []),
          ...accountSourceFields,
        ])],
        });
      });
      return generated;
    })()
    : [
      {
        lineNo: 1,
        summary: "采购原材料",
        accountCode: debitAccountCode,
        accountName: debitAccountName,
        debitCents: event.amountCents,
        creditCents: 0,
        dimensions: {
          department: event.department,
          project: event.project || null,
          supplier: event.counterparty,
        },
        requiredDimensions: [],
        explanation: `命中 ${ruleVersion}：借记 ${debitAccountCode} ${debitAccountName}`,
        sourceFields: ["业务类型", "含税金额", "部门", "项目"],
      },
      {
        lineNo: 2,
        summary: `确认应付款 · ${event.counterparty}`,
        accountCode: creditAccountCode,
        accountName: creditAccountName,
        debitCents: 0,
        creditCents: event.amountCents,
        dimensions: {
          department: event.department,
          project: event.project || null,
          supplier: event.counterparty,
        },
        requiredDimensions: ["supplier"],
        explanation: `命中 ${ruleVersion}：贷记 ${creditAccountCode} ${creditAccountName}`,
        sourceFields: ["供应商", "含税金额"],
      },
    ];
  const voucher = {
    id: `VCH-${Date.now()}-${sequence}`,
    number: `记-草稿-${String(sequence).padStart(4, "0")}`,
    company: event.company,
    ledger: event.ledger,
    accountingDate: event.date,
    period: event.date.slice(0, 7),
    voucherType: "记",
    summary: event.summary,
    sourceEventIds: (
      Array.isArray(options.sourceEventIds) && options.sourceEventIds.length
        ? [...new Set(options.sourceEventIds)]
        : [event.id]
    ),
    status: event.exceptionIds.length ? "待处理" : "待审核",
    ruleVersion,
    appliedRuleId: rule.id,
    operator: "",
    financeReviewed: false,
    pushAllowed: false,
    externalReference: null,
    lines,
  };
  voucher.validation = validateVoucher(voucher);
  if (!voucher.validation.valid) voucher.status = "待处理";
  return voucher;
}

export function applyVoucherLineEdits(
  voucher,
  lines,
  operator,
  reason,
  editedAt = new Date().toISOString(),
) {
  if (!["待审核", "待处理", "已确认"].includes(voucher.status)) {
    throw new Error("已推送凭证不能在本地直接编辑");
  }
  if (!String(reason || "").trim()) throw new Error("请填写本次修改原因");
  const before = voucher.lines.map((line) => JSON.parse(JSON.stringify(line)));
  const candidate = {
    ...voucher,
    lines: lines.map((line, index) => ({
      ...line,
      lineNo: index + 1,
      explanation: `由 ${operator || "本机操作者"} 人工编辑并重新校验`,
    })),
    status: "待审核",
    editedAt,
    editedBy: operator || "本机操作者",
    editHistory: [
      ...(voucher.editHistory || []),
      {
        before,
        after: lines.map((line) => JSON.parse(JSON.stringify(line))),
        operator: operator || "本机操作者",
        reason: String(reason).trim(),
        at: editedAt,
        previousStatus: voucher.status,
      },
    ],
  };
  const validation = validateVoucher(candidate);
  if (!validation.valid) throw new Error(validation.errors[0]);
  candidate.validation = validation;
  return candidate;
}

export function eligibleForBatchConfirmation(state) {
  return state.vouchers.filter((voucher) => {
    if (voucher.status !== "待审核" || !validateVoucher(voucher).valid) return false;
    return !voucher.sourceEventIds.some((eventId) => {
      const event = state.events.find((item) => item.id === eventId);
      return event?.exceptionIds.some((exceptionId) =>
        state.exceptions.some((item) => item.id === exceptionId && item.status === "待处理"));
    });
  });
}

export function splitEventForPartialPayment(
  event,
  settledCents,
  sequence = Date.now(),
  allocationTotalCents = event.amountCents,
) {
  if (!Number.isInteger(settledCents) || settledCents <= 0) {
    throw new Error("本次入账金额必须大于零");
  }
  if (!Number.isInteger(allocationTotalCents) || allocationTotalCents <= settledCents) {
    throw new Error("拆分总额必须大于本次确认入账金额");
  }
  const originalCents = event.amountCents;
  const remainingCents = allocationTotalCents - settledCents;
  const settledEvent = {
    ...event,
    amountCents: settledCents,
    amountBreakdown: {
      ...(event.amountBreakdown || {}),
      grossCents: settledCents,
      paymentCents: settledCents,
    },
    allocationHistory: [
      ...(event.allocationHistory || []),
      {
        originalCents,
        allocationTotalCents,
        settledCents,
        remainingCents,
        at: new Date().toISOString(),
      },
    ],
    matchExplanation: [
      ...(event.matchExplanation || []),
        `人工确认差异总额 ${formatMoney(allocationTotalCents)} 中本次入账 ${formatMoney(settledCents)}，剩余 ${formatMoney(remainingCents)} 待后续匹配`,
    ],
  };
  const residualEvent = {
    ...event,
    id: `${event.id}-REM-${sequence}`,
    reference: `${event.reference}-剩余`,
    businessKey: `${event.businessKey || event.id}|remaining|${sequence}`,
    amountCents: remainingCents,
    amountBreakdown: {
      grossCents: remainingCents,
      netCents: null,
      taxCents: null,
      paymentCents: null,
    },
    summary: `${event.summary}（剩余待匹配）`,
    sourceRecords: [],
    exceptionIds: [],
    status: "待处理",
    matchConfidence: null,
    derivedFromEventId: event.id,
    allocationHistory: [],
    matchExplanation: [`由事项 ${event.reference} 的部分付款人工拆分产生`],
  };
  return { settledEvent, residualEvent };
}

export function buildLedger(vouchers) {
  const accountMap = new Map();
  vouchers
    .filter((voucher) => ["已确认", "已推送"].includes(voucher.status))
    .flatMap((voucher) => voucher.lines.map((line) => ({ ...line, voucher })))
    .forEach(({ voucher, ...line }) => {
      const key = line.accountCode;
      const current = accountMap.get(key) || {
        accountCode: key,
        accountName: line.accountName,
        debitCents: 0,
        creditCents: 0,
        latestDate: voucher.accountingDate,
      };
      current.debitCents += line.debitCents || 0;
      current.creditCents += line.creditCents || 0;
      current.latestDate = current.latestDate > voucher.accountingDate
        ? current.latestDate
        : voucher.accountingDate;
      accountMap.set(key, current);
    });
  return [...accountMap.values()].map((row) => ({
    ...row,
    balanceCents: row.debitCents - row.creditCents,
  }));
}

export function buildIdempotencyKey(voucher) {
  return [
    voucher.company,
    voucher.ledger,
    voucher.sourceEventIds.join("+"),
    voucher.ruleVersion,
  ].join("|");
}
