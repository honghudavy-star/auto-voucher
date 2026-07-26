const roundPattern = /^-?\d+(?:\.\d{0,2})?$/;

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
    currency: "CNY",
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
    (line.requiredDimensions || []).forEach((dimension) => {
      if (!line.dimensions?.[dimension]) {
        const labels = {
          department: "部门",
          project: "项目",
          costCenter: "成本中心",
          customer: "客户",
          supplier: "供应商",
          employee: "员工",
        };
        errors.push(`第 ${index + 1} 行缺少必填辅助核算：${labels[dimension] || dimension}`);
      }
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

export function ruleMatchesEvent(rule, event) {
  if (!rule?.enabled) return false;
  const match = rule.match || {};
  if (match.businessType && match.businessType !== event.type) return false;
  if (match.counterparty && match.counterparty !== event.counterparty) return false;
  return Boolean(match.businessType || match.counterparty);
}

export function selectPostingRule(rules, event) {
  return [...(rules || [])]
    .filter((rule) => ruleMatchesEvent(rule, event) && rule.posting?.debitAccountCode
      && rule.posting?.creditAccountCode)
    .sort((left, right) => (right.priority || 0) - (left.priority || 0))[0] || null;
}

export function matchingPostingRules(rules, event) {
  return [...(rules || [])]
    .filter((rule) => ruleMatchesEvent(rule, event) && rule.posting?.debitAccountCode
      && rule.posting?.creditAccountCode)
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

export function createPurchaseVoucher(event, sequence = 1, rule = null) {
  if (!rule?.enabled || !rule?.posting?.debitAccountCode || !rule?.posting?.creditAccountCode) {
    throw new Error("未命中已启用且完整的凭证规则；请先创建待配置事项并完成人工确认");
  }
  const posting = rule.posting;
  const debitAccountCode = posting.debitAccountCode;
  const debitAccountName = posting.debitAccountName || "";
  const creditAccountCode = posting.creditAccountCode;
  const creditAccountName = posting.creditAccountName || "";
  const ruleVersion = `${rule.name} v${rule.version}`;
  const voucher = {
    id: `VCH-${Date.now()}-${sequence}`,
    number: `记-草稿-${String(sequence).padStart(4, "0")}`,
    company: event.company,
    ledger: event.ledger,
    accountingDate: event.date,
    period: event.date.slice(0, 7),
    voucherType: "记",
    summary: event.summary,
    sourceEventIds: [event.id],
    status: event.exceptionIds.length ? "待处理" : "待审核",
    ruleVersion,
    appliedRuleId: rule.id,
    operator: "",
    financeReviewed: false,
    pushAllowed: false,
    externalReference: null,
    lines: [
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
    ],
  };
  voucher.validation = validateVoucher(voucher);
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
