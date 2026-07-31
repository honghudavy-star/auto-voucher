import { isApprovalRecord } from "./approval-processing.js";

const BANK_EVIDENCE = /(银行|流水|回单|对账)/;

function normalizedReference(value) {
  return String(value ?? "").trim();
}

function sourceReference(event, field) {
  return (event?.sourceRecords || [])
    .map((record) => normalizedReference(record?.referenceFields?.[field]))
    .find(Boolean) || "";
}

function bankSourceRecords(event) {
  return (event?.sourceRecords || []).filter((record) =>
    normalizedReference(record?.referenceFields?.bankSerial)
    || BANK_EVIDENCE.test(String(record?.documentType || "")));
}

export function isBankRecord(event) {
  if (!event) return false;
  return Boolean(
    normalizedReference(event.bankSerial)
    || sourceReference(event, "bankSerial")
    || bankSourceRecords(event).length,
  );
}

export function approvalReferenceForEvent(event, side = "approval") {
  const explicit = normalizedReference(
    event?.approvalNo
    || sourceReference(event, "approvalNo"),
  );
  if (explicit) return explicit;
  if (side === "approval") {
    return normalizedReference(event?.externalId || event?.reference);
  }
  return normalizedReference(event?.reference);
}

function bankAmountForEvent(event) {
  const amounts = bankSourceRecords(event)
    .map((record) => record?.amountCents)
    .filter(Number.isInteger);
  if (amounts.length) {
    return amounts.reduce((total, amount) => total + Math.abs(amount), 0);
  }
  return Number.isInteger(event?.amountCents) ? Math.abs(event.amountCents) : null;
}

function signedBankAmount(amount, direction) {
  if (!Number.isInteger(amount)) return null;
  const normalizedDirection = normalizedReference(direction).toLowerCase();
  if (normalizedDirection === "outflow") return -Math.abs(amount);
  if (normalizedDirection === "inflow") return Math.abs(amount);
  return amount;
}

function bankSignedAmountForEvent(event) {
  const bankRecords = bankSourceRecords(event);
  const signedAmounts = bankRecords
    .map((record) => signedBankAmount(
      record?.amountCents,
      record?.referenceFields?.bankDirection || event?.bankDirection,
    ))
    .filter(Number.isInteger);
  if (signedAmounts.length) {
    return signedAmounts.reduce((total, amount) => total + amount, 0);
  }
  return signedBankAmount(
    event?.amountCents,
    event?.bankDirection || sourceReference(event, "bankDirection"),
  );
}

function approvalAmountForEvent(event) {
  return Number.isInteger(event?.amountCents) ? event.amountCents : null;
}

function rowId(reference, bankEvent, approvalEvent) {
  return [
    "approval-bank",
    normalizedReference(reference) || "no-reference",
    bankEvent?.id || "no-bank",
    approvalEvent?.id || "no-approval",
  ].join("::");
}

function unionRow(reference, bankEvent = null, approvalEvent = null) {
  const bankAmountCents = bankEvent ? bankAmountForEvent(bankEvent) : null;
  const bankSignedAmountCents = bankEvent ? bankSignedAmountForEvent(bankEvent) : null;
  const approvalAmountCents = approvalEvent ? approvalAmountForEvent(approvalEvent) : null;
  let status = "amount_mismatch";
  if (!bankEvent) status = "approval_only";
  else if (!approvalEvent) status = "bank_only";
  else if (
    Number.isInteger(bankAmountCents)
    && Number.isInteger(approvalAmountCents)
    && bankAmountCents === approvalAmountCents
  ) status = "matched";
  return {
    id: rowId(reference, bankEvent, approvalEvent),
    reference: normalizedReference(reference),
    bankEvent,
    approvalEvent,
    bankAmountCents,
    bankSignedAmountCents,
    approvalAmountCents,
    amountDifferenceCents: (
      Number.isInteger(bankAmountCents) && Number.isInteger(approvalAmountCents)
        ? bankAmountCents - approvalAmountCents
        : null
    ),
    status,
    sourceEventIds: [...new Set(
      [bankEvent?.id, approvalEvent?.id].filter(Boolean),
    )],
  };
}

function takeExactAmountMatch(approvals, approval, usedBankIds) {
  return approvals.find((bank) =>
    !usedBankIds.has(bank.id)
    && bankAmountForEvent(bank) === approvalAmountForEvent(approval));
}

export function buildApprovalBankUnion(events) {
  const approvalGroups = new Map();
  const bankGroups = new Map();

  (events || []).forEach((event) => {
    if (isApprovalRecord(event)) {
      const reference = approvalReferenceForEvent(event, "approval")
        || `approval-without-reference:${event.id}`;
      if (!approvalGroups.has(reference)) approvalGroups.set(reference, []);
      approvalGroups.get(reference).push(event);
    }
    if (isBankRecord(event)) {
      const reference = approvalReferenceForEvent(event, "bank")
        || `bank-without-reference:${event.id}`;
      if (!bankGroups.has(reference)) bankGroups.set(reference, []);
      bankGroups.get(reference).push(event);
    }
  });

  const references = new Set([...approvalGroups.keys(), ...bankGroups.keys()]);
  const rows = [];
  [...references].sort((left, right) => left.localeCompare(right, "zh-CN"))
    .forEach((reference) => {
      const approvals = approvalGroups.get(reference) || [];
      const banks = bankGroups.get(reference) || [];
      const usedBankIds = new Set();
      const usedApprovalIds = new Set();

      approvals.forEach((approval) => {
        const bank = takeExactAmountMatch(banks, approval, usedBankIds);
        if (!bank) return;
        usedBankIds.add(bank.id);
        usedApprovalIds.add(approval.id);
        rows.push(unionRow(reference, bank, approval));
      });

      const remainingApprovals = approvals.filter((item) => !usedApprovalIds.has(item.id));
      const remainingBanks = banks.filter((item) => !usedBankIds.has(item.id));
      const pairedCount = Math.min(remainingApprovals.length, remainingBanks.length);
      for (let index = 0; index < pairedCount; index += 1) {
        rows.push(unionRow(reference, remainingBanks[index], remainingApprovals[index]));
      }
      remainingBanks.slice(pairedCount)
        .forEach((bank) => rows.push(unionRow(reference, bank, null)));
      remainingApprovals.slice(pairedCount)
        .forEach((approval) => rows.push(unionRow(reference, null, approval)));
    });

  return rows;
}

export function assignApprovalAccount(record, account, processedBy, processedAt) {
  if (!isApprovalRecord(record)) throw new Error("只能为审批记录补充科目");
  if (
    !account?.id
    || !account?.code
    || !account?.name
    || account.category !== "account"
    || account.active === false
    || account.status === "停用"
  ) {
    throw new Error("请选择当前有效的科目主数据");
  }
  record.debitAccountMasterDataId = account.id;
  record.debitAccountCode = account.code;
  record.debitAccountName = account.name;
  record.approvalProcessing = {
    status: "processed",
    mode: "manual",
    processedAt,
    processedBy,
  };
  return record;
}

export function buildUnionVoucherEvent(row) {
  const approval = row?.approvalEvent;
  const bank = row?.bankEvent;
  const base = approval || bank;
  if (!base) throw new Error("联合数据行缺少可生成凭证的来源记录");
  const amountCents = Number.isInteger(row.bankAmountCents)
    ? row.bankAmountCents
    : row.approvalAmountCents;
  if (!Number.isInteger(amountCents)) throw new Error("联合数据行缺少有效金额");
  return {
    ...base,
    id: approval?.id || bank?.id,
    reference: row.reference || base.reference,
    date: bank?.date || approval?.date || base.date,
    counterparty: approval?.counterparty || bank?.counterparty || "",
    amountCents,
    amountBreakdown: {
      ...(approval?.amountBreakdown || bank?.amountBreakdown || {}),
      grossCents: approval?.amountBreakdown?.grossCents
        ?? row.approvalAmountCents
        ?? amountCents,
      paymentCents: row.bankAmountCents,
    },
    currency: approval?.currency || bank?.currency || "CNY",
    department: approval?.department || bank?.department || "",
    project: approval?.project || bank?.project || "",
    summary: approval?.summary || bank?.summary || row.reference,
    debitAccountMasterDataId: approval?.debitAccountMasterDataId || "",
    debitAccountCode: approval?.debitAccountCode || "",
    debitAccountName: approval?.debitAccountName || "",
    bankSerial: bank?.bankSerial || sourceReference(bank, "bankSerial"),
    bankAmountCents: row.bankAmountCents,
    approvalAmountCents: row.approvalAmountCents,
    amountDifferenceCents: row.amountDifferenceCents,
    approvalBankUnionStatus: row.status,
    approvalBankUnionRowId: row.id,
    unionSourceEventIds: [...row.sourceEventIds],
    exceptionIds: [],
  };
}
