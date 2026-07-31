const LEGACY_STORAGE_KEYS = ["auto-voucher:p0-state:v1", "auto-voucher:state:v1"];

function now(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

let saveQueue = Promise.resolve();

function normalizeState(state) {
  if (state.version !== 2) throw new Error("本地服务尚未完成生产状态升级");
  state.operatorConfigured ??= false;
  state.enterpriseProfiles ||= [];
  state.sourceSystems ||= [];
  state.templateProfiles ||= [];
  state.connectors ||= [];
  state.activeFinanceConnectorId ||= "";
  state.activeWorkflowConnectorId ||= "";
  state.syncLog ||= [];
  state.externalQueryCache ||= [];
  state.externalReadCache ||= [];
  state.approvalProcessingRules ||= [];
  state.approvalUnionSelections ||= {};
  state.approvalProcessingConfirmations ||= {};
  return state;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const supportCode = payload.correlationId || response.headers.get("X-Correlation-ID") || "";
    const error = new Error(
      `${payload.error || `本地服务请求失败（${response.status}）`}${supportCode ? `（支持编号：${supportCode}）` : ""}`,
    );
    error.correlationId = supportCode;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function waitForJob(submission, onProgress) {
  if (!submission.job?.id) return submission;
  while (true) {
    const payload = await apiRequest(`/api/jobs/${encodeURIComponent(submission.job.id)}`);
    const job = payload.job;
    onProgress?.(job);
    if (job.status === "completed") return job.result;
    if (job.status === "failed") throw new Error(job.error || "后台任务失败");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function loadState() {
  LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
  const payload = await apiRequest("/api/state");
  if (!payload.state) throw new Error("本地服务未返回生产工作区状态");
  return normalizeState(payload.state);
}

export function saveState(state) {
  state.lastSavedAt = now();
  const snapshot = JSON.parse(JSON.stringify(state));
  const request = saveQueue
    .catch(() => undefined)
    .then(() => apiRequest("/api/state", {
      method: "PUT",
      body: JSON.stringify({ state: snapshot }),
    }));
  saveQueue = request;
  request.catch((error) => {
    window.dispatchEvent(new CustomEvent("auto-voucher:sync-error", { detail: error.message }));
  });
  return request;
}

export async function resetState() {
  const payload = await apiRequest("/api/setup/reset", {
    method: "POST",
    body: JSON.stringify({ confirmation: "备份并全量初始化" }),
  });
  LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
  return normalizeState(payload.state);
}

export function appendAudit(state, action, subject, detail) {
  state.auditLog.unshift({
    id: `LOG-${Date.now()}`,
    action,
    subject,
    operator: state.operator || "本机操作者",
    detail,
    at: now(),
  });
}

export function createBackup(state) {
  return JSON.stringify({
    kind: "auto-voucher-backup",
    exportedAt: now(),
    state,
  }, null, 2);
}

export function restoreBackup(raw) {
  const payload = JSON.parse(raw);
  if (payload.kind !== "auto-voucher-backup" || !payload.state?.version) {
    throw new Error("不是有效的 Auto Voucher 备份包");
  }
  saveState(payload.state);
  return payload.state;
}

export async function previewImportFile(file) {
  const body = new FormData();
  body.append("file", file);
  return apiRequest("/api/import/preview", { method: "POST", body });
}

export async function importFiles(files, options = {}) {
  const body = new FormData();
  files.forEach((file) => body.append("files", file));
  if (options.mapping) body.append("mapping", JSON.stringify(options.mapping));
  if (options.templateName) body.append("templateName", options.templateName);
  const submission = await apiRequest("/api/import", { method: "POST", body });
  return waitForJob(submission, options.onProgress);
}

export function restoreDefaultAccounts() {
  return apiRequest("/api/master-data/accounts/restore-defaults", {
    method: "POST",
    body: JSON.stringify({ confirmation: "恢复默认科目" }),
  });
}

export async function downloadBackup() {
  const response = await fetch("/api/backup", { cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "备份生成失败");
  }
  return response.blob();
}

export function fetchDiagnosticLogs(filters = {}) {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  });
  return apiRequest(`/api/diagnostics/logs?${query}`);
}

export function fetchDiagnosticSummary(hours = 24) {
  return apiRequest(`/api/diagnostics/summary?hours=${encodeURIComponent(hours)}`);
}

export function saveDiagnosticSettings(retentionDays, maxEntries) {
  return apiRequest("/api/diagnostics/settings", {
    method: "PUT",
    body: JSON.stringify({ retentionDays, maxEntries }),
  });
}

export async function downloadDiagnosticBundle(days = 7) {
  const response = await fetch(
    `/api/diagnostics/export?days=${encodeURIComponent(days)}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "诊断包生成失败");
  }
  return {
    blob: await response.blob(),
    supportCode: response.headers.get("X-Support-Code") || "",
  };
}

export function reportClientDiagnostic(payload) {
  return fetch("/api/diagnostics/client", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

export async function restoreServerBackup(file) {
  const body = new FormData();
  body.append("backup", file);
  return apiRequest("/api/restore", { method: "POST", body });
}

export async function previewServerBackup(file) {
  const body = new FormData();
  body.append("backup", file);
  return apiRequest("/api/restore/preview", { method: "POST", body });
}

export function configureConnector(connectorId, config, productionConfirmation = "") {
  return apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/config`, {
    method: "PUT",
    body: JSON.stringify({ config, productionConfirmation }),
  });
}

export function configureConnectorApprovalQuery(connectorId, config) {
  return apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/approval-config`, {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
}

export function saveConnectorSecret(connectorId, name, value) {
  return apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/secret`, {
    method: "POST",
    body: JSON.stringify({ name, value }),
  });
}

export function testConnector(connectorId) {
  return apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/test`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function readConnectorApprovalFields(connectorId, profileId = "") {
  return apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/approval-fields`, {
    method: "POST",
    body: JSON.stringify({ profileId }),
  });
}

export async function syncConnectorApprovals(connectorId, onProgress) {
  const submission = await apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/sync-approvals`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return waitForJob(submission, onProgress);
}

export async function syncConnectorMasterData(connectorId, onProgress) {
  const submission = await apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/sync-master-data`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return waitForJob(submission, onProgress);
}

export function queryExternalVoucher(connectorId, query) {
  return apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/query-voucher`, {
    method: "POST",
    body: JSON.stringify(query),
  });
}

export function queryExternalLedger(connectorId, query) {
  return apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/query-ledger`, {
    method: "POST",
    body: JSON.stringify(query),
  });
}

export function queryExternalReport(connectorId, query) {
  return apiRequest(`/api/connectors/${encodeURIComponent(connectorId)}/query-report`, {
    method: "POST",
    body: JSON.stringify(query),
  });
}

export function preflightVoucher(voucherId, connectorId, expectedEnvironment) {
  return apiRequest(`/api/vouchers/${encodeURIComponent(voucherId)}/preflight`, {
    method: "POST",
    body: JSON.stringify({ connectorId, expectedEnvironment }),
  });
}

export function pushVoucherToConnector(voucherId, connectorId, expectedEnvironment) {
  return apiRequest(`/api/vouchers/${encodeURIComponent(voucherId)}/push`, {
    method: "POST",
    body: JSON.stringify({ connectorId, expectedEnvironment }),
  });
}

export function recheckExternalVoucher(voucherId, connectorId) {
  return apiRequest(`/api/vouchers/${encodeURIComponent(voucherId)}/recheck`, {
    method: "POST",
    body: JSON.stringify({ connectorId }),
  });
}

export function fetchSetupCatalog() {
  return apiRequest("/api/setup/catalog");
}

export function fetchRuntimeStatus() {
  return apiRequest("/api/runtime/status");
}

export function fetchEnvironmentStatus() {
  return apiRequest("/api/environment/status");
}

export function runEnvironmentCheck(includeNetwork = true, browserChecks = []) {
  return apiRequest("/api/environment/check", {
    method: "POST",
    body: JSON.stringify({ includeNetwork, browserChecks }),
  });
}

export function repairEnvironment(action) {
  return apiRequest("/api/environment/repair", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

export function fetchUpdateStatus() {
  return apiRequest("/api/update/status");
}

export function runUpdateAction(action, payload = {}) {
  return apiRequest(`/api/update/${encodeURIComponent(action)}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchDiagnosticCopySummary() {
  return apiRequest("/api/diagnostics/copy-summary");
}

export function generateSetupPlan(payload) {
  return apiRequest("/api/setup/plan", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function runSetupPreflight() {
  return apiRequest("/api/setup/preflight", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function activateProduction(payload) {
  return apiRequest("/api/setup/activate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function previewTargetTemplate(file, targetSystemId) {
  const body = new FormData();
  body.append("file", file);
  body.append("targetSystemId", targetSystemId);
  return apiRequest("/api/templates/preview", { method: "POST", body });
}

export function validateTargetTemplate(payload) {
  return apiRequest("/api/templates/validate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
