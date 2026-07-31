export const APPROVAL_PROCESSING_FIELDS = Object.freeze([
  { key: "approvalName", label: "审批模板", type: "text" },
  { key: "reference", label: "审批单号", type: "text" },
  { key: "counterparty", label: "供应商 / 客商", type: "text" },
  { key: "department", label: "部门", type: "text" },
  { key: "project", label: "项目", type: "text" },
  { key: "businessType", label: "业务类型", type: "text" },
  { key: "summary", label: "摘要", type: "text" },
  { key: "date", label: "业务日期", type: "date" },
  { key: "approvalCompletedDate", label: "完成日期", type: "date" },
  { key: "amountCents", label: "金额", type: "money" },
  { key: "currency", label: "币别", type: "text" },
  { key: "approvalStatus", label: "审批状态", type: "status" },
]);

export const APPROVAL_PROCESSING_OPERATORS = Object.freeze([
  { key: "equals", label: "等于", types: ["text", "date", "money", "status"] },
  { key: "notEquals", label: "不等于", types: ["text", "date", "money", "status"] },
  { key: "contains", label: "包含", types: ["text"] },
  { key: "startsWith", label: "开头是", types: ["text"] },
  { key: "greaterThan", label: "大于", types: ["date", "money"] },
  { key: "lessThan", label: "小于", types: ["date", "money"] },
  { key: "isEmpty", label: "为空", types: ["text", "date", "money", "status"] },
  { key: "isNotEmpty", label: "不为空", types: ["text", "date", "money", "status"] },
]);

function approvalTemplateFieldType(field) {
  const descriptor = `${field?.type || ""} ${field?.name || ""}`.toLocaleLowerCase("zh-CN");
  if (/(amount|money|number|金额|数值)/.test(descriptor)) return "money";
  if (/(date|time|日期|时间|所属期)/.test(descriptor)) return "date";
  return "text";
}

export function approvalProfilesForConnector(connector) {
  const configuredProfiles = Array.isArray(connector?.approvalProfiles)
    ? connector.approvalProfiles.filter((profile) =>
      profile && String(profile.approvalCode || "").trim())
    : [];
  if (configuredProfiles.length) return configuredProfiles;
  const approvalCode = String(connector?.approvalCode || "").trim();
  if (!approvalCode) return [];
  return [{
    id: `legacy:${approvalCode}`,
    approvalCode,
    approvalName: connector?.approvalName || "",
    approvalFields: connector?.approvalFields || [],
    fieldMapping: connector?.fieldMapping || {},
    fieldSources: connector?.fieldSources || [],
    additionalApprovalFieldIds: connector?.additionalApprovalFieldIds || [],
    syncCursor: connector?.syncCursor || {},
    lastApprovalFieldsReadAt: connector?.lastApprovalFieldsReadAt || "",
  }];
}

export function approvalProfileForConnector(connector, profileId) {
  const profiles = approvalProfilesForConnector(connector);
  if (profileId === undefined || profileId === null) return profiles[0] || null;
  const requestedProfileId = String(profileId).trim();
  if (!requestedProfileId) return null;
  return profiles.find((profile) =>
    String(profile.id || "") === requestedProfileId) || null;
}

export function approvalProcessingFieldsForConnector(connector, profileId) {
  const seen = new Set(APPROVAL_PROCESSING_FIELDS.map((field) => field.key));
  const dynamicFields = [];
  const templateFields = profileId === undefined
    ? approvalProfilesForConnector(connector)
      .flatMap((profile) => profile.approvalFields || [])
    : approvalProfileForConnector(connector, profileId)?.approvalFields || [];
  (templateFields.length ? templateFields : connector?.approvalFields || []).forEach((field) => {
    const dynamicField = {
      key: `approvalField:${String(field.id || "")}`,
      label: `审批字段 · ${String(field.name || field.id || "未命名字段")}`,
      type: approvalTemplateFieldType(field),
      approvalFieldId: String(field.id || ""),
    };
    if (!dynamicField.approvalFieldId || seen.has(dynamicField.key)) return;
    seen.add(dynamicField.key);
    dynamicFields.push(dynamicField);
  });
  return [...APPROVAL_PROCESSING_FIELDS, ...dynamicFields];
}

export function approvalProcessingField(fieldKey, fields = APPROVAL_PROCESSING_FIELDS) {
  return fields.find((field) => field.key === fieldKey)
    || APPROVAL_PROCESSING_FIELDS[0];
}

export function approvalProcessingOperators(fieldKey, fields = APPROVAL_PROCESSING_FIELDS) {
  const type = approvalProcessingField(fieldKey, fields).type;
  return APPROVAL_PROCESSING_OPERATORS.filter((operator) => operator.types.includes(type));
}

export function isApprovalRecord(record) {
  return Boolean(
    record
    && (
      record.sourceSystem === "feishu"
      || record.approvalCode
      || record.approvalName
      || ["approved", "pending", "rejected"].includes(record.approvalStatus)
    )
  );
}

export function approvalCompletionDate(record) {
  const storedDate = String(record?.approvalCompletedDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(storedDate)) return storedDate;
  const completedAt = new Date(record?.approvalCompletedAt || "");
  if (Number.isNaN(completedAt.getTime())) return "";
  return completedAt.toISOString().slice(0, 10);
}

export function filterApprovalRecordsByCompletionDate(records, dateFrom, dateTo) {
  const start = String(dateFrom || "").trim();
  const end = String(dateTo || "").trim();
  if (!start && !end) return records;
  return (records || []).filter((record) => {
    const completionDate = approvalCompletionDate(record);
    return completionDate
      && (!start || completionDate >= start)
      && (!end || completionDate <= end);
  });
}

export function filterApprovalRecordsByProfile(records, approvalCode) {
  const selectedApprovalCode = String(approvalCode || "").trim();
  if (!selectedApprovalCode) return [];
  return (records || []).filter((record) =>
    String(record?.approvalCode || "").trim() === selectedApprovalCode);
}

export function normalizeApprovalProcessingConfirmations(confirmations) {
  if (!confirmations || typeof confirmations !== "object" || Array.isArray(confirmations)) return {};
  return Object.fromEntries(
    Object.entries(confirmations)
      .filter(([recordId, confirmation]) =>
        String(recordId || "").trim()
        && (confirmation === true
          || Boolean(confirmation && typeof confirmation === "object" && !Array.isArray(confirmation))))
      .map(([recordId, confirmation]) => [
        recordId,
        confirmation === true ? {} : { ...confirmation },
      ]),
  );
}

export function approvalRecordsForProcessing(records, confirmations) {
  const confirmed = normalizeApprovalProcessingConfirmations(confirmations);
  return (records || []).filter((record) =>
    !isApprovalRecord(record) || Object.hasOwn(confirmed, record.id));
}

export function updateApprovalProcessingConfirmations({
  records,
  confirmations,
  recordIds,
  confirmed,
  confirmedAt,
  confirmedBy,
}) {
  const approvalIds = new Set(
    (records || [])
      .filter(isApprovalRecord)
      .map((record) => String(record.id || "").trim())
      .filter(Boolean),
  );
  const selectedIds = [...new Set((recordIds || []).map((recordId) => String(recordId || "").trim()))]
    .filter((recordId) => approvalIds.has(recordId));
  if (!selectedIds.length) throw new Error("请至少选择一条有效的审批记录");

  const next = normalizeApprovalProcessingConfirmations(confirmations);
  selectedIds.forEach((recordId) => {
    if (confirmed) {
      next[recordId] = { confirmedAt, confirmedBy };
    } else {
      delete next[recordId];
    }
  });
  return next;
}

export function approvalFieldDisplayValue(value) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => approvalFieldDisplayValue(item))
      .filter(Boolean)
      .join(" / ");
  }
  if (typeof value === "object") {
    return Object.values(value)
      .map((item) => approvalFieldDisplayValue(item))
      .filter(Boolean)
      .join(" / ");
  }
  return String(value).trim();
}

export function approvalRecordFieldEntries(record) {
  return (record?.approvalFieldValues || [])
    .filter((field) => String(field?.id || "").trim())
    .map((field) => ({
      id: String(field.id),
      name: String(field.name || field.id || "未命名字段"),
      type: String(field.type || ""),
      value: field.value,
      displayValue: approvalFieldDisplayValue(field.value),
    }));
}

export function assignApprovalCounterpartyFromField({
  record,
  fieldId,
  selectedAt,
  selectedBy,
}) {
  if (!isApprovalRecord(record)) throw new Error("只能修改审批记录的供应商 / 客商");
  const field = approvalRecordFieldEntries(record)
    .find((item) => item.id === String(fieldId || ""));
  if (!field) throw new Error("请选择当前审批记录中的有效字段");
  if (!field.displayValue) throw new Error("所选审批字段没有可用值");
  if (!Object.hasOwn(record, "counterpartyMappedValue")) {
    record.counterpartyMappedValue = String(record.counterparty || "");
  }
  record.counterparty = field.displayValue;
  record.counterpartyFieldSelection = {
    fieldId: field.id,
    fieldName: field.name,
    selectedAt,
    selectedBy,
  };
  return record;
}

function normalizedText(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function normalizedDate(value) {
  const text = String(value ?? "").trim();
  if (/^\d{13}$/.test(text)) {
    const date = new Date(Number(text));
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text)
    ? text.slice(0, 10)
    : text;
}

function approvalFieldFilterValue(record, field) {
  if (!field.approvalFieldId) return record?.[field.key];
  const stored = (record?.approvalFieldValues || [])
    .find((item) => String(item?.id || "") === field.approvalFieldId);
  const values = Array.isArray(stored?.value) ? stored.value.flat(Infinity) : [stored?.value];
  const populated = values.filter((value) => value !== "" && value != null);
  if (!populated.length) return "";
  if (field.type === "money") {
    const amounts = populated.map((value) => Number(String(value).replaceAll(",", "").trim()));
    return amounts.every(Number.isFinite)
      ? amounts.reduce((total, amount) => total + amount, 0)
      : populated[0];
  }
  if (field.type === "date") return populated[0];
  return populated.map((value) =>
    typeof value === "object" ? JSON.stringify(value) : String(value)).join(" / ");
}

function normalizedComparableValue(field, value) {
  if (field.type === "money") {
    if (value === "" || value == null) return null;
    const amount = Number(String(value).replaceAll(",", "").trim());
    return Number.isFinite(amount) ? Math.round(amount * 100) : Number.NaN;
  }
  if (field.type === "date") return normalizedDate(value);
  return normalizedText(value);
}

export function approvalConditionComplete(condition, fields = APPROVAL_PROCESSING_FIELDS) {
  const operator = approvalProcessingOperators(condition?.field, fields)
    .find((item) => item.key === condition?.operator);
  if (!operator) return false;
  return ["isEmpty", "isNotEmpty"].includes(operator.key)
    || String(condition?.value ?? "").trim() !== "";
}

export function approvalRecordMatchesCondition(
  record,
  condition,
  fields = APPROVAL_PROCESSING_FIELDS,
) {
  if (!approvalConditionComplete(condition, fields)) return false;
  const field = approvalProcessingField(condition.field, fields);
  const actual = normalizedComparableValue(field, approvalFieldFilterValue(record, field));
  const expected = normalizedComparableValue(field, condition.value);
  if (Number.isNaN(expected)) return false;

  switch (condition.operator) {
    case "equals":
      return actual === expected;
    case "notEquals":
      return actual !== expected;
    case "contains":
      return actual.includes(expected);
    case "startsWith":
      return actual.startsWith(expected);
    case "greaterThan":
      return actual > expected;
    case "lessThan":
      return actual < expected;
    case "isEmpty":
      return actual == null || actual === "";
    case "isNotEmpty":
      return actual != null && actual !== "";
    default:
      return false;
  }
}

export function filterApprovalRecords(
  records,
  conditions,
  fields = APPROVAL_PROCESSING_FIELDS,
) {
  const completeConditions = (conditions || [])
    .filter((condition) => approvalConditionComplete(condition, fields));
  if (!completeConditions.length || completeConditions.length !== (conditions || []).length) return [];
  return (records || [])
    .filter(isApprovalRecord)
    .filter((record) =>
      completeConditions.every((condition) =>
        approvalRecordMatchesCondition(record, condition, fields)));
}

export function applyApprovalProcessing({
  records,
  conditions,
  account,
  ruleId,
  processedAt,
  processedBy,
}) {
  if (!account?.id || !account?.code || !account?.name) {
    throw new Error("请选择有效的借方科目");
  }
  const matches = new Set(filterApprovalRecords(records, conditions).map((record) => record.id));
  if (!matches.size) throw new Error("当前组合条件没有匹配的审批数据");

  const processedRecords = [];
  (records || []).forEach((record) => {
    if (!matches.has(record.id)) return;
    record.debitAccountMasterDataId = account.id;
    record.debitAccountCode = account.code;
    record.debitAccountName = account.name;
    record.approvalProcessing = {
      status: "processed",
      ruleId,
      processedAt,
      processedBy,
    };
    processedRecords.push(record);
  });
  return processedRecords;
}
