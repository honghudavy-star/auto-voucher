import "./styles.css";
import {
  AUXILIARY_DIMENSION_CATALOG,
  buildLedger,
  applyVoucherLineEdits,
  createRuleFromVoucherEdit,
  createRuleVersion,
  createPurchaseVoucher,
  eligibleForBatchConfirmation,
  filterLocalRecords,
  formatMoney,
  matchingPostingRules,
  normalizeDimensionBindings,
  postingRuleComplete,
  selectPostingRule,
  splitEventForPartialPayment,
  toCents,
  validateVoucher,
} from "./domain.js";
import {
  appendAudit,
  configureConnector,
  configureConnectorApprovalQuery,
  downloadBackup,
  downloadDiagnosticBundle,
  fetchDiagnosticCopySummary,
  fetchDiagnosticLogs,
  fetchDiagnosticSummary,
  fetchEnvironmentStatus,
  fetchRuntimeStatus,
  fetchSetupCatalog,
  fetchUpdateStatus,
  generateSetupPlan,
  importFiles,
  loadState,
  preflightVoucher,
  previewImportFile,
  previewServerBackup,
  pushVoucherToConnector,
  queryExternalLedger,
  queryExternalReport,
  queryExternalVoucher,
  readConnectorApprovalFields,
  recheckExternalVoucher,
  resetState,
  restoreDefaultAccounts,
  reportClientDiagnostic,
  repairEnvironment,
  restoreServerBackup,
  saveConnectorSecret,
  saveDiagnosticSettings,
  saveState,
  runEnvironmentCheck,
  runUpdateAction,
  syncConnectorApprovals,
  syncConnectorMasterData,
  testConnector,
} from "./store.js";
import {
  clampWorkflowCanvasNodeLeft,
  normalizeWorkflowCanvasEdgeX,
  resolveWorkflowCanvasEdgeMiddleX,
} from "./workflow-canvas.js";
import { workflowNodeIcon } from "./workflow-icons.js";
import {
  APPROVAL_PROCESSING_FIELDS,
  assignApprovalCounterpartyFromField,
  approvalConditionComplete,
  approvalCompletionDate,
  approvalFieldDisplayValue,
  approvalProcessingField,
  approvalProcessingFieldsForConnector,
  approvalProcessingOperators,
  approvalProfileForConnector,
  approvalProfilesForConnector,
  approvalRecordFieldEntries,
  approvalRecordMatchesCondition,
  approvalRecordsForProcessing,
  filterApprovalRecordsByCompletionDate,
  filterApprovalRecordsByProfile,
  isApprovalRecord,
  updateApprovalProcessingConfirmations,
} from "./approval-processing.js";
import {
  assignApprovalAccount,
  buildApprovalBankUnion,
  buildUnionVoucherEvent,
  isBankRecord,
} from "./approval-bank-union.js";

const app = document.querySelector("#app");
let state;
let setupCatalog = null;
let serviceError = "";
let environmentStatus = { overallStatus: "blocked", checks: [], repairActions: [] };
let updateStatus = {
  available: false,
  status: "launcher_unavailable",
  currentVersion: "0.2.0",
  progress: 0,
};
let runtimeStatus = { restartAllowed: false, restartBlockers: ["本地服务状态未知"] };
let sourceMultiselectDocumentHandler = null;
let runtimeStatusKeyHandler = null;
try {
  const [loadedState, catalogPayload, environmentPayload, updatePayload, runtimePayload] = await Promise.all([
    loadState(),
    fetchSetupCatalog(),
    fetchEnvironmentStatus(),
    fetchUpdateStatus(),
    fetchRuntimeStatus(),
  ]);
  state = loadedState;
  setupCatalog = catalogPayload.catalog;
  environmentStatus = environmentPayload;
  updateStatus = updatePayload;
  runtimeStatus = runtimePayload;
  environmentStatus = await runEnvironmentCheck(false, browserCapabilityChecks());
} catch (error) {
  serviceError = error.message;
  state = {
    version: 2,
    operator: "",
    sourceDocuments: [],
    events: [],
    vouchers: [],
    exceptions: [],
    rules: [],
    connectors: [],
    masterData: [],
    approvalProcessingRules: [],
    approvalUnionSelections: {},
    approvalProcessingConfirmations: {},
    auditLog: [],
    templateProfiles: [],
    readiness: {},
    productionActivation: { enabled: false },
  };
}
let route = "dashboard";
let activeWorkflowNode = null;
const WORKFLOW_CANVAS_STORAGE_KEY = "auto-voucher-workflow-canvas-v7-reference";
const WORKFLOW_CANVAS_VIEW_STORAGE_KEY = "auto-voucher-workflow-view-v1";
const WORKFLOW_CANVAS_EDGE_STORAGE_KEY = "auto-voucher-workflow-edges-v1";
const WORKFLOW_CANVAS_DEFAULT_POSITIONS = Object.freeze({
  "source-bank": { x: 0.035, y: 0.13 },
  "source-business": { x: 0.035, y: 0.32 },
  "source-approval": { x: 0.035, y: 0.51 },
  "source-depreciation": { x: 0.035, y: 0.7 },
  "process-bank": { x: 0.33, y: 0.13 },
  "process-business": { x: 0.33, y: 0.32 },
  "process-approval": { x: 0.33, y: 0.51 },
  "process-depreciation": { x: 0.33, y: 0.7 },
  "process-systems": { x: 0.33, y: 0.82 },
  "process-rules": { x: 0.58, y: 0.23 },
  "process-exceptions": { x: 0.58, y: 0.47 },
  "process-vouchers": { x: 0.58, y: 0.7 },
  "output-erp": { x: 0.82, y: 0.35 },
  "output-template": { x: 0.82, y: 0.61 },
});
const WORKFLOW_CANVAS_EDGES = Object.freeze([
  { from: "source-bank", to: "process-bank", tone: "source" },
  { from: "source-business", to: "process-business", tone: "source" },
  { from: "source-approval", to: "process-approval", tone: "source" },
  { from: "source-depreciation", to: "process-depreciation", tone: "source" },
  { from: "process-systems", to: "process-rules", tone: "process" },
  { from: "process-business", to: "process-rules", tone: "process" },
  { from: "process-bank", to: "process-rules", tone: "process" },
  { from: "process-approval", to: "process-rules", tone: "process" },
  { from: "process-depreciation", to: "process-rules", tone: "process" },
  { from: "process-rules", to: "process-exceptions", tone: "process" },
  { from: "process-exceptions", to: "process-vouchers", tone: "process" },
  { from: "process-vouchers", to: "output-erp", tone: "output" },
  { from: "process-vouchers", to: "output-template", tone: "output" },
]);

function defaultWorkflowCanvasPositions() {
  return Object.fromEntries(
    Object.entries(WORKFLOW_CANVAS_DEFAULT_POSITIONS).map(([id, position]) => [id, { ...position }]),
  );
}

function loadWorkflowCanvasPositions() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKFLOW_CANVAS_STORAGE_KEY) || "{}");
    const positions = defaultWorkflowCanvasPositions();
    Object.entries(stored).forEach(([id, position]) => {
      if (!(id in positions)) return;
      const x = Number(position?.x);
      const y = Number(position?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) positions[id] = { x, y };
    });
    return positions;
  } catch {
    return defaultWorkflowCanvasPositions();
  }
}

function saveWorkflowCanvasPositions() {
  localStorage.setItem(WORKFLOW_CANVAS_STORAGE_KEY, JSON.stringify(workflowCanvasPositions));
}

function workflowCanvasEdgeKey(from, to) {
  return `${from}::${to}`;
}

function loadWorkflowCanvasEdgeRoutes() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKFLOW_CANVAS_EDGE_STORAGE_KEY) || "{}");
    const allowedKeys = new Set(WORKFLOW_CANVAS_EDGES.map((edge) => workflowCanvasEdgeKey(edge.from, edge.to)));
    return Object.fromEntries(
      Object.entries(stored)
        .filter(([key, route]) => allowedKeys.has(key) && Number.isFinite(Number(route?.x)))
        .map(([key, route]) => [key, { x: Math.min(1, Math.max(0, Number(route.x))) }]),
    );
  } catch {
    return {};
  }
}

function saveWorkflowCanvasEdgeRoutes() {
  localStorage.setItem(WORKFLOW_CANVAS_EDGE_STORAGE_KEY, JSON.stringify(workflowCanvasEdgeRoutes));
}

function loadWorkflowCanvasView() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKFLOW_CANVAS_VIEW_STORAGE_KEY) || "{}");
    const zoom = Number(stored?.zoom);
    return {
      x: 0,
      y: 0,
      zoom: Number.isFinite(zoom) ? Math.min(1.65, Math.max(0.55, zoom)) : 1,
    };
  } catch {
    return { x: 0, y: 0, zoom: 1 };
  }
}

function saveWorkflowCanvasView() {
  localStorage.setItem(WORKFLOW_CANVAS_VIEW_STORAGE_KEY, JSON.stringify(workflowCanvasView));
}

let workflowCanvasPositions = loadWorkflowCanvasPositions();
let workflowCanvasView = loadWorkflowCanvasView();
let workflowCanvasEdgeRoutes = loadWorkflowCanvasEdgeRoutes();
let pendingFiles = [];
let importResult = null;
let importPreview = null;
let importPreviewError = "";
let importPreviewLoading = false;
let importProgress = null;
let fieldMapping = {};
let mappingTemplateName = "";
let editingVoucherId = null;
let query = "";
let queryView = "vouchers";
let ruleEditorOpen = false;
let editingRuleId = null;
let ruleEditorDraft = null;
let selectedRuleLineIndex = 0;
let expandedRuleLineIndex = null;
let expandedRuleLineField = "";
let connectorJob = null;
let selectedConnectorId = "kingdee-k3cloud";
let selectedApprovalConnectorId = "feishu-approval";
let selectedApprovalProfileId = "";
let approvalWorkspacePanel = "query";
let approvalDataFilters = {
  keyword: "",
};
let approvalDataCustomFilterDrafts = [];
let approvalDataCustomFilters = [];
let approvalFiltersExpanded = false;
let selectedApprovalDetailId = null;
let editingApprovalCounterpartyId = null;
const selectedApprovalRecordIds = new Set();
let systemsPanelId = "master-data";
let masterDataFilters = {
  category: "all",
  source: "all",
  status: "active",
  search: "",
};
let masterDataPage = 0;
let editingMasterDataId = null;
let diagnosticResult = { items: [], total: 0, limit: 100, offset: 0, filters: { levels: [], categories: [] } };
let diagnosticSummary = { total: 0, byLevel: {}, byCategory: {}, settings: { retentionDays: 30, maxEntries: 50000 } };
let diagnosticFilters = { level: "", category: "", search: "", days: "7" };
let diagnosticPage = 0;
let diagnosticLoading = false;
let runtimeStatusOpen = false;
const QUERY_RENDER_LIMIT = 100;
const MASTER_DATA_PAGE_SIZE = 50;
const APPROVAL_DATA_RENDER_LIMIT = 100;

function browserCapabilityChecks() {
  return [
    ["browser-fetch", "网络请求能力", typeof fetch === "function", true],
    ["browser-file", "文件读取能力", typeof File === "function", true],
    ["browser-blob", "文件导出能力", typeof Blob === "function", true],
    ["browser-crypto", "浏览器安全能力", Boolean(globalThis.crypto?.subtle), true],
    ["browser-clipboard", "剪贴板能力", Boolean(navigator.clipboard), false],
    ["browser-dom", "页面交互能力", Boolean(document.querySelector && globalThis.CustomEvent), true],
  ].map(([id, name, available, blocking]) => ({
    id,
    name,
    status: available ? "passed" : "warning",
    severity: available ? "info" : blocking ? "blocking" : "warning",
    actual: available ? "可用" : "不可用",
    required: "现代 Edge 或 Chrome",
    blocking: Boolean(blocking && !available),
    productionBlocking: Boolean(blocking && !available),
    action: available ? "无需操作。" : "升级到当前稳定版 Edge 或 Chrome。",
  }));
}

function applyBrowserCapabilityChecks() {
  const capabilities = browserCapabilityChecks();
  const existing = new Map((environmentStatus.checks || []).map((item) => [item.id, item]));
  capabilities.forEach((item) => existing.set(item.id, item));
  environmentStatus.checks = [...existing.values()];
  if (capabilities.some((item) => item.blocking)) {
    environmentStatus.overallStatus = "blocked";
  } else if (environmentStatus.overallStatus === "ok" && capabilities.some((item) => item.status !== "passed")) {
    environmentStatus.overallStatus = "degraded";
  }
}

applyBrowserCapabilityChecks();

const mappingFields = [
  ["date", "业务日期", false],
  ["counterparty", "供应商 / 客商", true],
  ["amount", "付款金额", true, "multiple"],
  ["reference", "审批单号 / 单据号", false],
  ["department", "部门", false],
  ["project", "项目", false],
  ["summary", "摘要", false],
  ["currency", "币别", false],
  ["exchange_rate", "汇率", false],
];

function normalizeMappingSelection(value) {
  if (Array.isArray(value)) return [...new Set(value.filter(Boolean).map(String))];
  return value ? [String(value)] : [];
}

function paymentAmountMappingControl() {
  const selected = normalizeMappingSelection(fieldMapping.amount);
  const selectionLabel = selected.length ? selected.join("、") : "请选择付款金额字段";
  const renderGroup = (label, headers) => headers.length ? `
    <div class="mapping-multi-group">
      <strong>${label}</strong>
      ${headers.map((header) => `
        <label class="mapping-multi-option">
          <input
            type="checkbox"
            data-mapping-multi-field="amount"
            value="${escapeHtml(header)}"
            ${selected.includes(header) ? "checked" : ""}
          />
          <span>${escapeHtml(header)}</span>
        </label>
      `).join("")}
    </div>
  ` : "";
  return `
    <div class="mapping-field">
      <span>付款金额 *</span>
      <details class="mapping-multi-select">
        <summary data-mapping-multi-summary="amount">${escapeHtml(selectionLabel)}</summary>
        <div class="mapping-multi-menu">
          ${renderGroup("源文件字段", importPreview.sourceHeaders)}
          ${renderGroup("系统处理字段", importPreview.derivedHeaders)}
        </div>
      </details>
      <small>可多选；每行使用所选字段中实际有金额的一列。</small>
    </div>
  `;
}

const approvalMappingFields = [
  ["date", "业务日期", "必填；请选择实际记账日期字段"],
  ["counterparty", "供应商 / 客商", "必填"],
  ["amount", "金额", "必填"],
  ["department", "部门", "可选"],
  ["project", "项目", "可选"],
  ["summary", "摘要", "可选"],
  ["currency", "币别", "可选；未映射时使用 CNY"],
  ["exchange_rate", "汇率", "可选；凭证场景可改用金蝶汇率体系"],
];

const routes = {
  plan: { label: "接入方案", icon: "link", path: "/setup/plan", section: "plan" },
  systems: { label: "系统与数据", icon: "tools", path: "/setup/systems", section: "systems" },
  rules: { label: "凭证场景", icon: "rules", path: "/setup/rules", section: "rules" },
  dashboard: { label: "流程工作区", icon: "home", path: "/workspace", section: "workspace" },
  bank: { label: "银行数据", icon: "chart", path: "/workspace/bank-data", section: "data" },
  business: { label: "业务数据", icon: "briefcase", path: "/workspace/business-data", section: "data" },
  depreciation: { label: "折旧摊销", icon: "refresh", path: "/workspace/depreciation-data", section: "data" },
  import: { label: "取数", icon: "upload", path: "/workspace/import", section: "workspace" },
  events: { label: "识别", icon: "briefcase", path: "/workspace/events", section: "workspace" },
  exceptions: { label: "识别异常", icon: "alert", path: "/workspace/exceptions", section: "workspace" },
  vouchers: { label: "生成及复核", icon: "voucher", path: "/workspace/vouchers", section: "workspace" },
  delivery: { label: "ERP 输出", icon: "arrow", path: "/workspace/erp-output", section: "workspace" },
  templates: { label: "凭证模板", icon: "download", path: "/workspace/templates", section: "workspace" },
  connectors: { label: "连接器", icon: "link", path: "/workspace/connectors", section: "tools" },
  approvals: { label: "审批数据", icon: "briefcase", path: "/workspace/approvals", section: "tools" },
  approvalProcessing: { label: "审批数据处理", icon: "rules", path: "/workspace/approval-processing", section: "workspace" },
  ocr: { label: "OCR", icon: "scan", path: "/workspace/ocr", section: "tools" },
  settings: { label: "通用设置", icon: "settings", path: "/workspace/settings", section: "tools" },
  diagnostics: { label: "诊断日志", icon: "file", path: "/workspace/diagnostics", section: "tools" },
  backup: { label: "备份与恢复", icon: "download", path: "/workspace/backup", section: "tools" },
};

const sidebarNavigation = [
  {
    label: "核心流程",
    items: [
      { route: "dashboard" },
      { route: "plan" },
      { route: "systems" },
      { route: "rules" },
    ],
  },
  {
    label: "业务数据",
    items: [
      { route: "bank" },
      { route: "business" },
      { route: "approvals" },
      { route: "depreciation" },
    ],
  },
  {
    label: "设置",
    items: [
      { route: "connectors" },
      { route: "ocr" },
      { route: "settings" },
      { route: "diagnostics" },
      { route: "backup" },
    ],
  },
];

const iconPaths = {
  home: '<path d="M3 11.5 12 4l9 7.5V21h-6v-6H9v6H3z"/>',
  upload: '<path d="M12 16V3m0 0L7 8m5-5 5 5"/><path d="M4 14v7h16v-7"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V4h8v3m-13 5h18"/>',
  voucher: '<path d="M5 3h11l3 3v15H5z"/><path d="M16 3v4h4M8 11h8M8 15h8"/>',
  alert: '<path d="m12 3 9.5 17h-19z"/><path d="M12 9v5m0 3h.01"/>',
  chart: '<path d="M4 20V10m6 10V4m6 16v-7m5 7H2"/>',
  rules: '<path d="M5 5h14M5 12h14M5 19h14"/><circle cx="9" cy="5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="19" r="2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  file: '<path d="M5 3h11l3 3v15H5z"/><path d="M16 3v4h4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  download: '<path d="M12 3v13m0 0 5-5m-5 5-5-5"/><path d="M4 20h16"/>',
  refresh: '<path d="M20 6v5h-5"/><path d="M19 11a7 7 0 1 0 1 5"/>',
  tools: '<path d="m14.7 6.3 3-3a5 5 0 0 1-6.3 6.3L5.2 15.8a2.1 2.1 0 0 0 3 3l6.2-6.2a5 5 0 0 1 6.3-6.3l-3 3"/><path d="m4 4 4 4"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  shield: '<path d="M12 3 5 6v5c0 4.7 2.7 8.1 7 10 4.3-1.9 7-5.3 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 1 1 3.8 2.1c-1 .6-1.5 1.1-1.5 2.4M12 17h.01"/>',
  pointer: '<path d="m5 3 13 9-6 1-3 6z"/>',
  hand: '<path d="M7 11V7a1.5 1.5 0 0 1 3 0v3-5a1.5 1.5 0 0 1 3 0v5-4a1.5 1.5 0 0 1 3 0v5-2a1.5 1.5 0 0 1 3 0v4c0 5-3 8-8 8-4 0-6-2-8-5l-2-3a1.5 1.5 0 0 1 2.4-1.8L7 14"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
};

function icon(name, className = "") {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name]}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const CONFIG_VALUE_MASK = "********";

function maskedConfigValue(value) {
  return String(value ?? "").trim() ? CONFIG_VALUE_MASK : "";
}

function submittedConfigValue(value, existingValue) {
  const submitted = String(value ?? "").trim();
  return submitted === CONFIG_VALUE_MASK
    ? String(existingValue ?? "").trim()
    : submitted;
}

function formatDate(value, withTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", withTime
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function statusTone(status) {
  if (["已推送", "已完成", "已确认", "connected", "已解决"].includes(status)) return "success";
  if (["待处理", "待补充", "推送失败", "阻断"].includes(status)) return "warning";
  if (["待审核", "可生成", "已生成", "推送中", "状态待确认"].includes(status)) return "pending";
  return "neutral";
}

function getSelectedEvent() {
  return state.events.find((event) => event.id === state.selectedEventId) || state.events[0];
}

function getVoucherForEvent(eventId) {
  return state.vouchers.find((voucher) => voucher.sourceEventIds.includes(eventId));
}

function routeFromHash() {
  const path = window.location.hash.replace(/^#/, "") || routes.dashboard.path;
  return Object.entries(routes).find(([, item]) => item.path === path)?.[0] || "dashboard";
}

function routeHash(nextRoute) {
  return `#${routes[nextRoute]?.path || routes.dashboard.path}`;
}

function navigate(nextRoute, { replace = false } = {}) {
  if (!routes[nextRoute]) nextRoute = "dashboard";
  if (nextRoute !== "approvals") {
    selectedApprovalDetailId = null;
    editingApprovalCounterpartyId = null;
  }
  const nextHash = routeHash(nextRoute);
  if (window.location.hash !== nextHash) {
    window.history[replace ? "replaceState" : "pushState"]({}, "", nextHash);
  }
  route = nextRoute;
  if (nextRoute !== "dashboard") activeWorkflowNode = null;
  render();
  if (nextRoute === "diagnostics") refreshDiagnostics();
  document.querySelector(".workspace")?.scrollTo({ top: 0, behavior: "instant" });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function persist(action, subject, detail) {
  if (action) appendAudit(state, action, subject, detail);
  saveState(state);
  render();
}

function sidebar() {
  return `
    <aside class="sidebar glass-panel">
      <button class="brand-row brand-home" data-route="dashboard" aria-label="返回流程工作区">
        <span class="brand-mark">${icon("voucher")}</span>
        <div><strong>Auto Voucher</strong><small>本地凭证工作台</small></div>
      </button>
      <nav class="side-nav" aria-label="主导航">
        ${sidebarNavigation.map((group) => `
          <section class="side-nav-group" aria-labelledby="side-nav-${group.items[0].route}">
            <p class="side-nav-group-label" id="side-nav-${group.items[0].route}">${group.label}</p>
            <div class="side-nav-group-items">
              ${group.items.map((item) => {
                const target = routes[item.route];
                return `
                  <button
                    class="primary-nav-item ${route === item.route ? "active" : ""}"
                    data-route="${item.route}"
                    aria-current="${route === item.route ? "page" : "false"}"
                    aria-label="${target.label}"
                    title="${target.label}"
                  >
                    ${icon(target.icon)}
                    <span class="nav-item-label">${target.label}</span>
                  </button>
                `;
              }).join("")}
            </div>
          </section>
        `).join("")}
      </nav>
    </aside>
  `;
}

function workflowReturnBar() {
  return `
    <nav class="workflow-return-bar" aria-label="页面位置">
      <button class="workflow-return-button" data-route="dashboard">${icon("arrow")}返回流程工作区</button>
      ${route === "approvals" ? "" : `<span>${escapeHtml(routes[route]?.label || "")}</span>`}
    </nav>
  `;
}

function globalSearchBox(className = "") {
  return `
    <div class="search-box ${className}">
      ${icon("search")}
      <input data-global-search value="${escapeHtml(query)}" placeholder="搜索事项、凭证、供应商或金额" aria-label="全局搜索" />
    </div>
  `;
}

function workflowNode({
  id,
  title,
  description,
  iconName,
  meta,
}) {
  const selected = activeWorkflowNode === id;
  return `
    <button
      class="workflow-node ${selected ? "selected" : ""}"
      data-workflow-node="${escapeHtml(id)}"
      aria-expanded="${selected}"
    >
      <span class="workflow-node-icon">${icon(iconName)}</span>
      <span class="workflow-node-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></span>
      ${meta ? `<span class="workflow-node-meta">${escapeHtml(meta)}</span>` : ""}
      <span class="workflow-node-disclosure">${icon("chevron")}</span>
    </button>
  `;
}

function workflowRouteLink({ route: target, title, description, iconName = "arrow" }) {
  return `
    <button class="workflow-route-link" data-route="${escapeHtml(target)}">
      <span>${icon(iconName)}</span>
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></span>
      ${icon("arrow")}
    </button>
  `;
}

function eventRow(event, compact = false) {
  const selected = event.id === state.selectedEventId;
  const exceptionCount = event.exceptionIds.filter((id) =>
    state.exceptions.some((item) => item.id === id && item.status === "待处理")).length;
  return `
    <button class="event-row ${selected ? "selected" : ""}" data-event-id="${event.id}">
      <span class="event-symbol ${statusTone(event.status)}">${exceptionCount ? "!" : icon("check")}</span>
      <span class="event-main"><strong>${escapeHtml(event.type)}</strong><small>${escapeHtml(event.counterparty)}</small></span>
      ${compact ? "" : `<span class="event-source"><strong>${escapeHtml(event.reference)}</strong><small>${event.matchConfidence == null ? "匹配证据待计算" : `${Math.round(event.matchConfidence * 100)}% 匹配`}</small></span>`}
      <strong class="event-amount">${formatMoney(event.amountCents)}</strong>
      <span class="status-pill ${statusTone(event.status)}">${escapeHtml(event.status)}</span>
      ${icon("chevron", "row-chevron")}
    </button>
  `;
}

function voucherPreview(event, voucher) {
  if (!event) return `<div class="empty-state">${icon("voucher")}<h3>暂无业务事项</h3></div>`;
  if (!voucher) {
    const blocked = event.exceptionIds.some((id) =>
      state.exceptions.some((item) => item.id === id && item.status === "待处理"));
    return `
      <div class="preview-empty">
        <span class="large-icon">${icon(blocked ? "alert" : "voucher")}</span>
        <h3>${blocked ? "处理异常后生成凭证" : "该事项尚未生成凭证"}</h3>
        <p>${blocked ? "存在阻断异常，系统不会绕过人工判断。" : "将应用采购付款规则，生成借贷平衡的草稿。"}</p>
        <button class="primary-button" data-generate="${event.id}" ${blocked ? "disabled" : ""}>${icon("plus")}生成凭证草稿</button>
      </div>
    `;
  }
  const validation = validateVoucher(voucher);
  const isEditing = editingVoucherId === voucher.id;
  return `
    <div class="voucher-head">
      <div><span class="eyebrow">记账凭证预览</span><h3>${escapeHtml(voucher.number)}</h3></div>
      <span class="status-pill ${statusTone(voucher.status)}">${escapeHtml(voucher.status)}</span>
    </div>
    <div class="voucher-meta">
      <span><small>业务日期</small>${voucher.accountingDate}</span>
      <span><small>规则版本</small>${escapeHtml(voucher.ruleVersion)}</span>
      <span><small>来源</small>${voucher.sourceEventIds.length} 项</span>
    </div>
    <div class="voucher-table">
      <div class="voucher-tr voucher-th"><span>摘要 / 科目</span><span>借方</span><span>贷方</span></div>
      ${voucher.lines.map((line, index) => isEditing ? `
        <div class="voucher-edit-row" data-edit-line="${index}">
          <div class="voucher-edit-main">
            <input data-line-field="summary" value="${escapeHtml(line.summary)}" aria-label="第 ${index + 1} 行摘要" />
            <div>
              <input data-line-field="accountCode" value="${escapeHtml(line.accountCode)}" aria-label="第 ${index + 1} 行科目编码" />
              <input data-line-field="accountName" value="${escapeHtml(line.accountName)}" aria-label="第 ${index + 1} 行科目名称" />
            </div>
          </div>
          <input class="money-input" data-line-field="debit" value="${line.debitCents ? (line.debitCents / 100).toFixed(2) : ""}" inputmode="decimal" aria-label="第 ${index + 1} 行借方" />
          <input class="money-input" data-line-field="credit" value="${line.creditCents ? (line.creditCents / 100).toFixed(2) : ""}" inputmode="decimal" aria-label="第 ${index + 1} 行贷方" />
        </div>
        <div class="voucher-dimension-row" data-edit-dimensions="${index}">
          ${Object.entries(line.dimensions || {}).map(([key, value]) => {
            const definition = AUXILIARY_DIMENSION_CATALOG.find((item) => item.key === key);
            return `<label><span>${escapeHtml(definition?.label || key)}</span><input data-dimension-field="${escapeHtml(key)}" value="${escapeHtml(value || "")}" /></label>`;
          }).join("")}
        </div>
      ` : `
        <div class="voucher-tr">
          <span><strong>${escapeHtml(line.summary)}</strong><small>${line.accountCode} · ${escapeHtml(line.accountName)}</small></span>
          <strong>${line.debitCents ? formatMoney(line.debitCents).replace("¥", "") : "—"}</strong>
          <strong>${line.creditCents ? formatMoney(line.creditCents).replace("¥", "") : "—"}</strong>
        </div>
      `).join("")}
      <div class="voucher-tr voucher-total">
        <span>合计</span>
        <strong>${formatMoney(validation.debitCents).replace("¥", "")}</strong>
        <strong>${formatMoney(validation.creditCents).replace("¥", "")}</strong>
      </div>
    </div>
    <div class="balance-strip ${validation.valid ? "valid" : "invalid"}">
      <span>${icon(validation.valid ? "check" : "alert")}</span>
      <div><small>校验结果</small><strong>${validation.valid ? "借贷平衡，可进入人工审核" : validation.errors[0]}</strong></div>
    </div>
    <div class="evidence-block">
      <strong>${isEditing ? "编辑说明" : "生成依据"}</strong>
      ${voucher.ruleSelection ? `<p class="${voucher.ruleSelection.conflict ? "rule-conflict-note" : ""}">${escapeHtml(voucher.ruleSelection.explanation)}</p>` : ""}
      ${voucher.lines.map((line) => `<p>${escapeHtml(line.explanation || "由人工编辑并重新校验")}</p>`).join("")}
    </div>
    ${isEditing ? `
      <div class="edit-reason-card">
        <label><span>修改原因 *</span><input data-edit-reason placeholder="例如：根据已确认科目表改用库存商品科目" /></label>
        <label class="check-row"><input type="checkbox" data-save-as-rule />将本次科目修改保存为一条待启用规则</label>
      </div>
    ` : ""}
    ${voucher.editHistory?.length ? `
      <details class="change-history">
        <summary>查看修改记录（${voucher.editHistory.length}）</summary>
        ${voucher.editHistory.slice().reverse().map((entry) => `
          <div><strong>${escapeHtml(entry.operator)} · ${formatDate(entry.at, true)}</strong>
          <p>${escapeHtml(entry.reason)}；原状态 ${escapeHtml(entry.previousStatus)}</p></div>
        `).join("")}
      </details>
    ` : ""}
    ${voucher.externalReference ? `
      <div class="external-reference">
        ${icon("link")}<div><strong>${escapeHtml(voucher.externalReference.externalNumber)}</strong><small>${escapeHtml(voucher.externalReference.externalId)} · ${escapeHtml(voucher.externalReference.status)} · ${escapeHtml(voucher.externalReference.system)} · ${formatDate(voucher.externalReference.verifiedAt, true)} 回查</small></div>
      </div>
    ` : ""}
    <div class="preview-actions">
      ${isEditing
        ? `<button class="quiet-button" data-cancel-edit="${voucher.id}">取消</button>
           <button class="primary-button" data-save-edit="${voucher.id}">${icon("check")}保存并重新校验</button>`
        : `<button class="quiet-button" data-return="${voucher.id}">退回补充</button>
           ${["待审核", "待处理", "已确认"].includes(voucher.status) ? `<button class="secondary-button" data-edit-voucher="${voucher.id}">编辑分录</button>` : ""}`}
      <button class="secondary-button" data-export="${voucher.id}" ${!["已确认", "已推送"].includes(voucher.status) ? "disabled" : ""}>${icon("download")}导出</button>
      ${!isEditing && voucher.status === "待审核"
        ? `<button class="primary-button" data-approve="${voucher.id}">${icon("check")}审核通过</button>`
        : ""}
      ${!isEditing && voucher.status === "已确认" && !voucher.pushAllowed
        ? `<button class="secondary-button" data-allow-push="${voucher.id}">${icon("shield")}单独允许推送</button>`
        : ""}
      ${!isEditing && voucher.status === "已确认" && voucher.pushAllowed
        ? `<button class="primary-button" data-push="${voucher.id}">${icon("arrow")}保存草稿并回查</button>`
        : ""}
      ${!isEditing && voucher.status === "状态待确认"
        ? `<button class="primary-button" data-recheck="${voucher.id}">${icon("refresh")}再次回查</button>`
        : ""}
    </div>
  `;
}

function gateStatus(gate) {
  const value = state.readiness?.[gate] || { status: "not_ready", reasons: [] };
  return {
    ...value,
    label: value.status === "ready" ? "已通过" : value.status === "invalid" ? "配置失效" : "未完成",
    tone: value.status === "ready" ? "success" : "warning",
  };
}

function environmentCard({ compact = false } = {}) {
  const issues = (environmentStatus.checks || []).filter((item) => item.status !== "passed");
  const productionBlockers = issues.filter((item) => item.productionBlocking);
  const reminders = issues.length - productionBlockers.length;
  const labels = { ok: "环境正常", degraded: "部分能力不可用", blocked: "环境阻断" };
  const tone = environmentStatus.overallStatus === "ok"
    ? "success"
    : environmentStatus.overallStatus === "blocked" ? "warning" : "pending";
  return `
    <section class="runtime-status-section environment-card ${compact ? "compact" : ""}" aria-labelledby="runtime-environment-title">
      <div class="panel-heading">
        <div><span class="eyebrow">运行环境</span><h2 id="runtime-environment-title">环境检测</h2></div>
        <span class="status-pill ${tone}">${labels[environmentStatus.overallStatus] || "尚未检测"}</span>
      </div>
      <p>${productionBlockers.length
        ? `${productionBlockers.length} 项生产前需要处理${reminders ? `，另有 ${reminders} 项运行提醒` : ""}。`
        : issues.length
          ? `${issues.length} 项运行提醒，不影响生产启用。`
          : "核心程序、数据库、存储和安全依赖均已通过检测。"}</p>
      ${issues.length ? `<div class="environment-issue-list">${issues.slice(0, compact ? 3 : 8).map((item) => `
        <div><span class="environment-check-mark ${item.productionBlocking ? "blocking" : ""}">${item.productionBlocking ? "!" : "·"}</span><p><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.action)}</small></p></div>
      `).join("")}</div>` : ""}
      <div class="card-actions">
        <button class="secondary-button" data-check-environment>${icon("refresh")}重新检测环境</button>
        ${!compact || issues.some((item) => ["disk-space", "core-assets"].includes(item.id))
          ? `<button class="text-button" data-repair-environment="clear-update-cache">清理旧版本和下载缓存</button>`
          : ""}
        ${compact ? "" : `<button class="text-button" data-repair-environment="recreate-shortcut" ${updateStatus.available ? "" : "disabled"}>重建桌面入口</button>`}
      </div>
      <small>支持编号 ${escapeHtml(environmentStatus.supportCode || "尚未生成")}</small>
    </section>
  `;
}

function updateCard() {
  const statusLabels = {
    launcher_unavailable: "开发运行",
    idle: "已是最新版本",
    available: "发现新版本",
    security_required: "需要安全更新",
    downloading: "正在下载",
    ready: "等待重启",
    applying: "正在更新",
    rollback: "已自动回退",
    error: "更新失败",
  };
  const status = updateStatus.status || "launcher_unavailable";
  const progress = Math.max(0, Math.min(100, Number(updateStatus.progress || 0)));
  return `
    <section class="runtime-status-section update-card" aria-labelledby="runtime-update-title">
      <div class="panel-heading">
        <div><span class="eyebrow">程序版本</span><h2 id="runtime-update-title">版本与更新</h2></div>
        <span class="status-pill ${["idle", "ready"].includes(status) ? "success" : status === "error" ? "warning" : "pending"}">${statusLabels[status] || escapeHtml(status)}</span>
      </div>
      <div class="version-line"><span><small>当前版本</small><strong>${escapeHtml(updateStatus.currentVersion || runtimeStatus.coreVersion || "未知")}</strong></span>${updateStatus.availableVersion ? `<span><small>可用版本</small><strong>${escapeHtml(updateStatus.availableVersion)}</strong></span>` : ""}</div>
      ${["downloading", "ready"].includes(status) ? `<div class="update-progress"><i style="width:${progress}%"></i></div><small>下载进度 ${progress}%</small>` : ""}
      ${updateStatus.releaseNotes
        ? `<p>${escapeHtml(updateStatus.releaseNotes)}</p>`
        : `<p>${escapeHtml(status === "launcher_unavailable"
          ? "当前为本地开发运行；正式版通过 Windows 启动器检查和安装更新。"
          : updateStatus.message || "启动器负责校验、下载、版本切换和失败回退。")}</p>`}
      ${runtimeStatus.restartBlockers?.length ? `<div class="privacy-note warning">${icon("alert")}${runtimeStatus.restartBlockers.map(escapeHtml).join("；")}</div>` : ""}
      <div class="card-actions">
        <button class="secondary-button" data-update-action="check" ${!updateStatus.available ? "disabled" : ""}>${icon("refresh")}检查更新</button>
        ${["available", "security_required"].includes(status) ? `<button class="primary-button" data-update-action="download">下载更新</button>` : ""}
        ${status === "ready" ? `<button class="primary-button" data-update-action="apply" ${runtimeStatus.restartAllowed ? "" : "disabled"}>${icon("shield")}重启并更新</button>` : ""}
        ${["available", "ready"].includes(status) ? `<button class="text-button" data-update-action="postpone">稍后提醒</button>` : ""}
      </div>
    </section>
  `;
}

function runtimeStatusControl() {
  const issues = (environmentStatus.checks || []).filter((item) => item.status !== "passed");
  const productionBlockers = issues.filter((item) => item.productionBlocking);
  const systemsGate = gateStatus("systems");
  const systemsReady = systemsGate.status === "ready";
  const statusLabel = systemsReady ? "系统已就绪" : "配置未完成";
  const statusTone = productionBlockers.length
    ? "warning"
    : systemsReady && !issues.length ? "success" : "pending";
  return `
    <button
      class="runtime-status-control"
      data-open-runtime-status
      aria-haspopup="dialog"
      aria-label="查看系统状态详情"
    >
      <span class="runtime-status-control-icon">${icon("settings")}</span>
      <span class="runtime-status-control-copy">
        <small>系统状态</small>
        <strong><i class="${statusTone}"></i>${statusLabel}</strong>
      </span>
      <span class="runtime-status-control-detail">查看详情</span>
      ${icon("chevron")}
    </button>
  `;
}

function runtimeStatusDialog() {
  if (!runtimeStatusOpen) return "";
  const systemsGate = gateStatus("systems");
  const systemsReady = systemsGate.status === "ready";
  const systemsReasons = (systemsGate.reasons || []).filter(Boolean);
  return `
    <div class="runtime-status-layer" data-runtime-status-layer>
      <section class="runtime-status-dialog glass-panel" role="dialog" aria-modal="true" aria-labelledby="runtime-status-title">
        <header class="runtime-status-dialog-header">
          <div><span class="eyebrow">系统状态</span><h2 id="runtime-status-title">${systemsReady ? "系统已就绪" : "配置未完成"}</h2><p>配置进度、运行环境和程序版本集中显示在这里。</p></div>
          <button class="quiet-button runtime-status-close" data-close-runtime-status aria-label="关闭系统状态弹窗">${icon("close")}</button>
        </header>
        <div class="runtime-configuration-summary ${systemsReady ? "success" : "pending"}">
          <span>${icon(systemsReady ? "check" : "alert")}</span>
          <div><strong>${systemsReady ? "系统与数据配置已完成" : "还需要完成系统与数据配置"}</strong><p>${systemsReady
            ? "连接器和目标主数据已达到当前门槛。"
            : systemsReasons.map(escapeHtml).join("；") || "请完成连接器测试和目标主数据同步。"}</p></div>
        </div>
        <div class="runtime-status-dialog-grid">
          ${environmentCard()}
          ${updateCard()}
        </div>
      </section>
    </div>
  `;
}

function planPage() {
  const target = state.targetSystem || {};
  const sources = new Set((state.sourceSystems || []).map((item) => item.id));
  const targets = setupCatalog?.targets || [];
  const sourceOptions = (setupCatalog?.sources || []).filter((item) => !item.hidden);
  const selectedSourceLabels = sourceOptions
    .filter((item) => sources.has(item.id))
    .map((item) => `${item.brand} ${item.product}`);
  const sourceSummary = selectedSourceLabels.length ? selectedSourceLabels.join("、") : "请选择";
  return `
    <section class="page-heading">
      <div><span class="eyebrow">生产配置 · 第 1 级门槛</span><h1>接入方案</h1><p>选择目标 ERP 和数据来源，再由本地能力目录确定性生成完整数据流程；无需填写版本、部署方式或企业信息。</p></div>
      <span class="status-pill ${gateStatus("plan").tone}">${gateStatus("plan").label}</span>
    </section>
    <form class="setup-layout" data-setup-plan>
      <article class="glass-panel setup-form-panel">
        <div class="panel-heading"><div><span class="eyebrow">凭证接收端</span><h2>目标 ERP</h2></div></div>
        <div class="form-grid setup-target-grid">
          <label><span>ERP 名称 *</span><select name="targetSystemId" required>
            <option value="">请选择</option>
            ${targets.map((item) => `<option value="${item.id}" ${target.id === item.id ? "selected" : ""}>${escapeHtml(`${item.brand} ${item.product}`)}</option>`).join("")}
          </select></label>
          <div class="setup-field">
            <span>数据来源 *</span>
            <details class="setup-multiselect" data-source-multiselect>
              <summary><span data-source-summary>${escapeHtml(sourceSummary)}</span>${icon("chevron")}</summary>
              <div class="setup-multiselect-menu" role="group" aria-label="数据来源">
                ${sourceOptions.map((item) => `<label><input type="checkbox" name="sourceSystemIds" value="${item.id}" data-source-label="${escapeHtml(`${item.brand} ${item.product}`)}" ${sources.has(item.id) ? "checked" : ""} /><span>${escapeHtml(`${item.brand} ${item.product}`)}</span></label>`).join("")}
              </div>
            </details>
          </div>
        </div>
        <p class="setup-choice-help">数据来源可以多选。请选择实际使用的 OA 或本地文件；API 数据源将在下一步配置接口、鉴权、记录路径和字段映射。</p>
        <div class="form-actions"><button class="primary-button" type="submit">${icon("rules")}生成接入方案</button><span>配置变化会自动使下游验证失效</span></div>
      </article>
      <article class="glass-panel flow-plan-panel">
        <div class="panel-heading"><div><span class="eyebrow">确定性方案</span><h2>数据流程全方案</h2></div></div>
        ${state.flowPlan?.steps?.length ? `
          <ol class="flow-plan-list">${state.flowPlan.steps.map((step) => `<li><b>${step.order}</b><div><strong>${escapeHtml(step.name)}</strong><p>${escapeHtml(step.detail)}</p></div></li>`).join("")}</ol>
          ${(state.flowPlan.blockers || []).length ? `<div class="privacy-note warning">${icon("alert")}${state.flowPlan.blockers.map(escapeHtml).join("；")}</div>` : ""}
        ` : `<div class="empty-state">${icon("rules")}<h3>尚未生成方案</h3><p>完成左侧必填项后生成连接方式、人工节点、阻断项和回查路径。</p></div>`}
      </article>
    </form>
  `;
}

const masterDataCategoryLabels = {
  organization: "组织",
  accountBook: "账簿",
  account: "科目",
  customer: "客户",
  supplier: "供应商",
  department: "部门",
  employee: "员工",
  project: "项目",
  otherCounterparty: "其他往来",
  counterparty: "其他往来",
  assistantCategory: "辅助资料类别",
  assistantData: "辅助资料",
  dimensionDefinition: "核算维度定义",
  accountDimension: "科目核算维度",
  dimensionGroup: "核算维度组",
  dimensionValue: "核算维度值",
  dimensionSupplier: "核算维度·供应商",
  dimensionDepartment: "核算维度·部门",
  dimensionCustomer: "核算维度·客户",
  dimensionEmployee: "核算维度·员工",
  dimensionMaterial: "核算维度·物料",
  dimensionExpense: "核算维度·费用项目",
  dimensionOrganization: "核算维度·组织机构",
  dimensionBank: "核算维度·银行",
  dimensionBankAccount: "核算维度·银行账号",
  dimensionOtherCounterparty: "核算维度·其他往来",
  dimensionServiceType: "核算维度·服务类型",
  dimensionUnit: "核算维度·Unit",
  dimensionRegion: "核算维度·入账地区",
  dimensionOldProject: "核算维度·旧项目",
  dimensionNewProject: "核算维度·新项目",
  expense: "费用项目",
  currency: "币种",
  exchangeRate: "汇率",
  taxRate: "税率",
  taxCode: "税码",
  unit: "计量单位",
  bank: "银行",
  material: "物料",
  stock: "仓库",
  costCenter: "成本中心",
  cashFlowItem: "现金流量项目",
};

const masterDataCategoryOrder = [
  "organization",
  "accountBook",
  "account",
  "customer",
  "supplier",
  "department",
  "employee",
  "project",
  "otherCounterparty",
  "counterparty",
  "assistantCategory",
  "assistantData",
  "dimensionDefinition",
  "accountDimension",
  "dimensionGroup",
  "dimensionValue",
  "dimensionSupplier",
  "dimensionDepartment",
  "dimensionCustomer",
  "dimensionEmployee",
  "dimensionMaterial",
  "dimensionExpense",
  "dimensionOrganization",
  "dimensionBank",
  "dimensionBankAccount",
  "dimensionOtherCounterparty",
  "dimensionServiceType",
  "dimensionUnit",
  "dimensionRegion",
  "dimensionOldProject",
  "dimensionNewProject",
  "expense",
  "currency",
  "exchangeRate",
  "taxRate",
  "taxCode",
  "unit",
  "bank",
  "material",
  "stock",
  "costCenter",
  "cashFlowItem",
];

function masterDataCategoryLabel(item) {
  return item.categoryLabel || masterDataCategoryLabels[item.category] || item.category || "未分类";
}

function masterDataSourceLabel(item) {
  if (item.sourceConnectorId) {
    return state.connectors?.find((connector) => connector.id === item.sourceConnectorId)?.name
      || item.sourceConnectorId;
  }
  return item.source || "本地维护";
}

function accountMasterDataPanel() {
  const records = state.masterData || [];
  const categories = [...new Set(records.map((item) => item.category).filter(Boolean))]
    .sort((left, right) => {
      const leftIndex = masterDataCategoryOrder.indexOf(left);
      const rightIndex = masterDataCategoryOrder.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) {
        return (leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER)
          - (rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER);
      }
      return masterDataCategoryLabel({ category: left })
        .localeCompare(masterDataCategoryLabel({ category: right }), "zh-CN");
    });
  const sources = [...new Set(records.map((item) => item.sourceConnectorId || item.source).filter(Boolean))]
    .map((value) => ({
      value,
      label: state.connectors?.find((connector) => connector.id === value)?.name || value,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
  const categoryScope = records
    .filter((item) => masterDataFilters.source === "all"
      || (item.sourceConnectorId || item.source) === masterDataFilters.source)
    .filter((item) => masterDataFilters.status === "all"
      || (masterDataFilters.status === "active" ? item.active !== false : item.active === false));
  const categoryCounts = categoryScope.reduce((counts, item) => {
    counts[item.category] = (counts[item.category] || 0) + 1;
    return counts;
  }, {});
  if (masterDataFilters.category !== "all" && !categories.includes(masterDataFilters.category)) {
    masterDataFilters.category = "all";
  }
  const needle = masterDataFilters.search.trim().toLowerCase();
  const filtered = records
    .filter((item) => masterDataFilters.category === "all" || item.category === masterDataFilters.category)
    .filter((item) => masterDataFilters.source === "all"
      || (item.sourceConnectorId || item.source) === masterDataFilters.source)
    .filter((item) => masterDataFilters.status === "all"
      || (masterDataFilters.status === "active" ? item.active !== false : item.active === false))
    .filter((item) => !needle || [item.code, item.name, item.group, masterDataSourceLabel(item)]
      .some((value) => String(value || "").toLowerCase().includes(needle)))
    .sort((left, right) => {
      const categoryOrder = masterDataCategoryLabel(left).localeCompare(masterDataCategoryLabel(right), "zh-CN");
      return categoryOrder || String(left.code).localeCompare(String(right.code), "zh-CN", { numeric: true });
    });
  const pageCount = Math.max(1, Math.ceil(filtered.length / MASTER_DATA_PAGE_SIZE));
  masterDataPage = Math.min(masterDataPage, pageCount - 1);
  const pageStart = masterDataPage * MASTER_DATA_PAGE_SIZE;
  const pageRecords = filtered.slice(pageStart, pageStart + MASTER_DATA_PAGE_SIZE);
  const source = state.defaultAccountSource || {};
  const categoryTitle = masterDataFilters.category === "all"
    ? "全部基础资料"
    : masterDataCategoryLabel({ category: masterDataFilters.category });

  return `
    <section class="account-master-panel master-data-panel glass-panel">
      <div class="master-data-commandbar">
        <div class="master-data-heading">
          <span class="eyebrow">目标主数据</span>
          <div class="master-data-titleline">
            <h2>${escapeHtml(categoryTitle)}</h2>
            <span class="master-data-count">${filtered.length} 条</span>
          </div>
        </div>
        <div class="account-master-actions">
          ${masterDataFilters.category === "account" || masterDataFilters.category === "all"
            ? `<button class="primary-button" data-add-account>${icon("plus")}新增科目</button>`
            : ""}
          <button class="secondary-button" data-route="import">${icon("upload")}导入基础资料</button>
          ${masterDataFilters.category === "account" || masterDataFilters.category === "all"
            ? `<button class="quiet-button" data-restore-default-accounts>${icon("refresh")}恢复默认科目</button>`
            : ""}
        </div>
      </div>
      <div class="master-data-categories" role="tablist" aria-label="基础资料分类">
        <button
          type="button"
          role="tab"
          class="master-data-category ${masterDataFilters.category === "all" ? "active" : ""}"
          aria-selected="${masterDataFilters.category === "all"}"
          data-master-category="all"
        >
          <span>全部</span><strong>${categoryScope.length}</strong>
        </button>
        ${categories.map((category) => `
          <button
            type="button"
            role="tab"
            class="master-data-category ${masterDataFilters.category === category ? "active" : ""}"
            aria-selected="${masterDataFilters.category === category}"
            data-master-category="${escapeHtml(category)}"
          >
            <span>${escapeHtml(masterDataCategoryLabel({ category }))}</span>
            <strong>${categoryCounts[category] || 0}</strong>
          </button>
        `).join("")}
      </div>
      <form class="master-data-filterbar" data-master-filter-form>
        <label>
          <span class="master-data-filter-label">数据来源</span>
          <select name="source" aria-label="数据来源">
            <option value="all" ${masterDataFilters.source === "all" ? "selected" : ""}>全部来源</option>
            ${sources.map((item) => `<option value="${escapeHtml(item.value)}" ${masterDataFilters.source === item.value ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}
          </select>
        </label>
        <label>
          <span class="master-data-filter-label">版本状态</span>
          <select name="status" aria-label="版本状态">
            <option value="active" ${masterDataFilters.status === "active" ? "selected" : ""}>当前有效</option>
            <option value="inactive" ${masterDataFilters.status === "inactive" ? "selected" : ""}>历史版本</option>
            <option value="all" ${masterDataFilters.status === "all" ? "selected" : ""}>全部状态</option>
          </select>
        </label>
        <label class="master-data-search">
          <span class="master-data-filter-label">搜索</span>
          <input name="search" aria-label="搜索基础资料" value="${escapeHtml(masterDataFilters.search)}" placeholder="搜索编码、名称、类别或来源" />
        </label>
        <button class="secondary-button" type="submit">${icon("search")}筛选</button>
        <button class="quiet-button" type="button" data-clear-master-filters>清除</button>
      </form>
      <div class="account-master-table-shell">
        <table class="account-master-table master-data-table" aria-label="基础资料表">
          <thead>
            <tr>
              <th scope="col">类型</th>
              <th scope="col">编码</th>
              <th scope="col">名称</th>
              <th scope="col">类别 / 分组</th>
              <th scope="col">来源</th>
              <th scope="col">状态</th>
              <th scope="col">版本</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            ${pageRecords.map((item) => {
              const editing = editingMasterDataId === item.id && item.category === "account";
              const active = item.active !== false;
              return `
                <tr class="account-master-row" data-account-row="${escapeHtml(item.id)}">
                  <td><span class="master-data-type">${escapeHtml(masterDataCategoryLabel(item))}</span></td>
                  <td>${editing
                    ? `<input data-account-field="code" value="${escapeHtml(item.code)}" aria-label="科目编码" />`
                    : `<code>${escapeHtml(item.code)}</code>`}</td>
                  <td>${editing
                    ? `<input data-account-field="name" value="${escapeHtml(item.name)}" aria-label="科目名称" />`
                    : `<strong>${escapeHtml(item.name)}</strong>`}</td>
                  <td>${editing
                    ? `<input data-account-field="group" value="${escapeHtml(item.group || "")}" aria-label="科目类别" placeholder="例如：资产类" />`
                    : escapeHtml(item.group || "—")}</td>
                  <td>${escapeHtml(masterDataSourceLabel(item))}</td>
                  <td>${editing
                    ? `<select data-account-field="status" aria-label="状态">
                        <option value="启用" ${item.status !== "停用" ? "selected" : ""}>启用</option>
                        <option value="停用" ${item.status === "停用" ? "selected" : ""}>停用</option>
                      </select>
                      <input data-account-field="normalBalance" value="${escapeHtml(item.normalBalance || "借")}" type="hidden" />`
                    : `<span class="status-pill ${active ? "success" : "neutral"}">${active ? "当前有效" : "历史版本"}</span>`}</td>
                  <td>v${escapeHtml(item.version || 1)}</td>
                  <td>
                    <span class="account-master-row-actions">
                      ${item.category === "account" && active
                        ? editing
                          ? `<button class="text-button" data-save-account="${escapeHtml(item.id)}">保存</button>
                             <button class="text-button" data-cancel-master-edit>取消</button>`
                          : `<button class="text-button" data-edit-master="${escapeHtml(item.id)}">编辑</button>
                             <button class="text-button danger-text" data-delete-account="${escapeHtml(item.id)}">停用</button>`
                        : `<span class="muted-copy">—</span>`}
                    </span>
                  </td>
                </tr>
              `;
            }).join("") || `<tr><td colspan="8"><div class="empty-state compact-empty">没有符合筛选条件的基础资料</div></td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="master-data-pagination">
        <span>显示 ${filtered.length ? pageStart + 1 : 0}–${Math.min(pageStart + MASTER_DATA_PAGE_SIZE, filtered.length)}，共 ${filtered.length} 条</span>
        <div>
          <button class="quiet-button" data-master-page="${masterDataPage - 1}" ${masterDataPage === 0 ? "disabled" : ""}>上一页</button>
          <strong>${masterDataPage + 1} / ${pageCount}</strong>
          <button class="quiet-button" data-master-page="${masterDataPage + 1}" ${masterDataPage >= pageCount - 1 ? "disabled" : ""}>下一页</button>
        </div>
      </div>
      ${masterDataFilters.category === "account" || masterDataFilters.category === "all"
        ? `<p class="muted-copy">默认科目依据《${escapeHtml(source.title || "小企业会计准则科目表")}》${escapeHtml(source.documentNumber || "")}；同步和手工修改均保留版本记录。</p>`
        : ""}
    </section>
  `;
}

function systemsPage() {
  const target = state.targetSystem;
  const connectors = state.connectors || [];
  if (!target) {
    return `
      <section class="page-heading"><div><span class="eyebrow">生产配置 · 第 2 级门槛</span><h1>系统与数据</h1><p>ERP 配置需在接入方案之后进行。</p></div><div class="heading-actions">${runtimeStatusControl()}<button class="primary-button" data-route="plan">前往接入方案</button></div></section>
      ${accountMasterDataPanel()}
      ${readonlyWorkspaceEmpty("尚未选择目标 ERP")}
    `;
  }
  const panels = [
    ...connectors.map((connector) => ({
      id: `connector:${connector.id}`,
      label: connector.name,
      meta: connector.type === "finance" ? "目标系统" : "数据来源",
      status: connector.status === "connected" ? "已连接" : connector.status === "error" ? "配置失效" : "待配置",
      tone: connector.status === "connected" ? "success" : "warning",
    })),
    {
      id: "master-data",
      label: "目标主数据",
      meta: "基础资料",
      status: `${(state.masterData || []).filter((item) => item.active !== false).length} 条有效`,
      tone: "neutral",
    },
  ];
  if (!panels.some((panel) => panel.id === systemsPanelId)) {
    systemsPanelId = panels[0]?.id || "master-data";
  }
  const selectedPanel = panels.find((panel) => panel.id === systemsPanelId);
  const selectedConnector = systemsPanelId.startsWith("connector:")
    ? connectors.find((connector) => connector.id === systemsPanelId.slice("connector:".length))
    : null;
  const panelContent = selectedConnector
    ? `<article class="systems-detail-panel glass-panel">
        <div class="panel-heading">
          <div>
            <span class="eyebrow">${selectedConnector.type === "finance" ? "目标系统" : "数据来源"}</span>
            <h2>${escapeHtml(selectedConnector.name)}</h2>
            <p>${escapeHtml(selectedConnector.environment || "测试环境")} · ${escapeHtml(selectedConnector.adapter)}</p>
          </div>
          <span class="status-pill ${selectedConnector.status === "connected" ? "success" : "warning"}">${selectedConnector.status === "connected" ? "测试通过" : selectedConnector.status === "error" ? "配置失效" : "待测试"}</span>
        </div>
        <div class="systems-detail-actions">
          <button class="primary-button" data-open-connector="${escapeHtml(selectedConnector.id)}">${icon("link")}配置与测试</button>
          ${selectedConnector.type === "finance" && selectedConnector.status === "connected"
            ? `<button class="secondary-button" data-sync-master="${escapeHtml(selectedConnector.id)}">${icon("refresh")}同步基础资料</button>`
            : ""}
        </div>
      </article>`
    : accountMasterDataPanel();

  return `
    <section class="page-heading">
      <div><span class="eyebrow">生产配置 · 第 2 级门槛</span><h1>系统与数据</h1><p>集中配置连接器、测试账套和目标基础资料。</p></div>
      <div class="heading-actions">${runtimeStatusControl()}</div>
    </section>
    <section class="systems-panel-selector glass-panel" role="tablist" aria-label="系统与数据模块">
      ${panels.map((panel) => `
        <button
          type="button"
          role="tab"
          class="systems-panel-option ${systemsPanelId === panel.id ? "active" : ""}"
          aria-selected="${systemsPanelId === panel.id}"
          data-systems-panel="${escapeHtml(panel.id)}"
        >
          <span>${escapeHtml(panel.meta)}</span>
          <strong>${escapeHtml(panel.label)}</strong>
          <small class="${panel.tone}">${escapeHtml(panel.status)}</small>
        </button>
      `).join("")}
    </section>
    <section class="systems-panel-content" aria-label="${escapeHtml(selectedPanel?.label || "系统与数据")}">
      ${panelContent}
    </section>
  `;
}

function readonlyWorkspaceEmpty(message) {
  return `<section class="glass-panel readonly-workspace"><div class="empty-state">${icon("shield")}<h3>${escapeHtml(message)}</h3><p>工作台保持只读，不会生成、导出或推送任何凭证。</p><button class="primary-button" data-route="plan">完成接入方案</button></div></section>`;
}

function dashboardPage() {
  const sourceNodes = [
    {
      id: "source-bank",
      kind: "source",
      title: "银行数据",
      description: "银行流水、回单及账户资料",
      iconName: "chart",
    },
    {
      id: "source-business",
      kind: "source",
      title: "业务数据",
      description: "发票、订单、费用及业务单据",
      iconName: "briefcase",
    },
    {
      id: "source-approval",
      kind: "source",
      title: "审批数据",
      description: "报销、付款及其他审批单据",
      iconName: "briefcase",
    },
    {
      id: "source-depreciation",
      kind: "source",
      title: "折旧摊销数据",
      description: "固定资产、待摊费用及期间数据",
      iconName: "refresh",
    },
  ];
  const sourceDetails = {
    "source-bank": {
      eyebrow: "银行数据如何进入",
      title: "选择接入方式",
      description: "先确定本地文件还是银行接口，再进入对应配置页面。",
      options: [
        { route: "import", title: "本地导入", description: "导入银行流水、回单或对账文件", iconName: "upload" },
        { route: "connectors", title: "API 接入", description: "配置银行或银企接口连接", iconName: "link" },
        { route: "plan", title: "数据源规划", description: "统一设置接入范围与实施步骤", iconName: "chart" },
      ],
    },
    "source-business": {
      eyebrow: "业务数据如何进入",
      title: "选择接入方式",
      description: "结构化文件、业务接口和票据识别分别进入对应页面。",
      options: [
        { route: "import", title: "本地导入", description: "CSV、TXT、XLS、XLSX、XML 等文件", iconName: "upload" },
        { route: "connectors", title: "API 接入", description: "配置业务系统或 OA 数据接口", iconName: "link" },
        { route: "ocr", title: "票据识别", description: "PDF、图片及扫描票据的本地 OCR", iconName: "scan" },
      ],
    },
    "source-approval": {
      eyebrow: "审批数据如何进入",
      title: "选择接入方式",
      description: "可以导入审批结果文件，也可以连接审批系统读取数据。",
      options: [
        { route: "import", title: "本地导入", description: "导入审批导出表或结构化文件", iconName: "upload" },
        { route: "approvals", title: "API 接入", description: "读取审批模板并映射业务字段", iconName: "link" },
      ],
    },
    "source-depreciation": {
      eyebrow: "折旧摊销数据如何进入",
      title: "选择接入方式",
      description: "导入固定资产与待摊数据，或从已有系统接口获取。",
      options: [
        { route: "import", title: "本地导入", description: "导入资产卡片、折旧或摊销明细", iconName: "upload" },
        { route: "connectors", title: "API 接入", description: "配置资产或财务系统数据接口", iconName: "link" },
      ],
    },
  };
  const processingNodes = [
    { id: "process-systems", kind: "process", route: "systems", title: "基础资料匹配", description: "科目、客商、部门、项目与账簿", iconName: "tools" },
    { id: "process-business", kind: "process", route: "events", title: "业务数据过滤", description: "整理业务事项并核对来源关系", iconName: "briefcase" },
    { id: "process-bank", kind: "process", route: "events", title: "银行数据过滤", description: "筛选流水并建立收付款关系", iconName: "chart" },
    { id: "process-approval", kind: "process", route: "approvalProcessing", title: "审批数据处理", description: "组合筛选并补充借方科目", iconName: "briefcase" },
    { id: "process-depreciation", kind: "process", route: "rules", title: "折旧与摊销", description: "配置期间处理及入账规则", iconName: "refresh" },
    { id: "process-rules", kind: "process", route: "rules", title: "凭证规则", description: "配置科目、条件和分录版本", iconName: "rules" },
    { id: "process-exceptions", kind: "process", route: "exceptions", title: "异常处理", description: "处理缺失、差异和低置信度项目", iconName: "alert" },
    {
      id: "process-vouchers",
      kind: "process",
      route: "vouchers",
      title: "生成凭证",
      description: "根据处理结果生成凭证草稿",
      iconName: "voucher",
    },
  ];
  const outputNodes = [
    {
      id: "output-erp",
      kind: "output",
      title: "ERP",
      description: "输出到已配置的财务系统",
      iconName: "link",
    },
    {
      id: "output-template",
      kind: "output",
      title: "凭证模板",
      description: "输出为可下载的凭证文件",
      iconName: "download",
    },
  ];
  const outputDetails = {
    "output-erp": {
      eyebrow: "ERP 如何接收",
      title: "选择输出方式",
      description: "选择 ERP 接收方式，或进入连接配置。",
      options: [
        { route: "delivery", title: "API 输出", description: "将凭证输出到当前 ERP", iconName: "arrow" },
        { route: "connectors", title: "ERP 连接配置", description: "配置金蝶、用友或其他 ERP", iconName: "link" },
      ],
    },
    "output-template": {
      eyebrow: "凭证如何导出",
      title: "选择模板",
      description: "当前提供通用 Excel 凭证模板。",
      options: [
        { route: "templates", title: "Excel 凭证模板", description: "下载包含凭证头、分录和辅助核算的文件", iconName: "download" },
      ],
    },
  };
  const processingDetails = Object.fromEntries(processingNodes.map((node) => [
    node.id,
    {
      eyebrow: "处理节点",
      title: node.title,
      description: node.description,
      options: [
        {
          route: node.route,
          title: `配置${node.title}`,
          description: "进入对应页面查看和调整处理规则",
          iconName: node.iconName,
        },
      ],
    },
  ]));
  const allNodes = [...sourceNodes, ...processingNodes, ...outputNodes];
  const activeNode = allNodes.find((node) => node.id === activeWorkflowNode);
  const activeDetail = sourceDetails[activeWorkflowNode]
    || processingDetails[activeWorkflowNode]
    || outputDetails[activeWorkflowNode];
  const kindLabel = {
    source: "数据来源",
    process: "数据处理",
    output: "输出目标",
  };
  const canvasNode = (node) => {
    const storedPosition = workflowCanvasPositions[node.id] || WORKFLOW_CANVAS_DEFAULT_POSITIONS[node.id];
    const x = Math.min(0.84, Math.max(0, Number(storedPosition?.x) || 0));
    const y = Math.min(0.82, Math.max(0.15, Number(storedPosition?.y) || 0.15));
    const selected = activeWorkflowNode === node.id;
    return `
      <button
        class="workflow-canvas-node workflow-canvas-node-${node.kind} ${selected ? "selected" : ""}"
        data-canvas-node="${escapeHtml(node.id)}"
        data-workflow-node="${escapeHtml(node.id)}"
        data-workflow-lane="${escapeHtml(node.kind)}"
        style="left:${(x * 100).toFixed(3)}%;top:${(y * 100).toFixed(3)}%"
        aria-label="${escapeHtml(node.title)}，拖动调整位置，单击配置"
        aria-pressed="${selected}"
      >
        <span class="workflow-canvas-port workflow-canvas-port-in" aria-hidden="true"></span>
        <span class="workflow-canvas-node-icon">${workflowNodeIcon(node.id)}</span>
        <span class="workflow-canvas-node-copy">
          <strong>${escapeHtml(node.title)}</strong>
          <small>${escapeHtml(node.description)}</small>
        </span>
        ${node.meta ? `<span class="workflow-canvas-node-meta">${escapeHtml(node.meta)}</span>` : ""}
        <span class="workflow-canvas-node-status" aria-hidden="true"></span>
        <span class="workflow-canvas-grip" aria-hidden="true"></span>
        <span class="workflow-canvas-port workflow-canvas-port-out" aria-hidden="true"></span>
      </button>
    `;
  };
  const inboundNodes = activeNode
    ? WORKFLOW_CANVAS_EDGES
      .filter((edge) => edge.to === activeNode.id)
      .map((edge) => allNodes.find((node) => node.id === edge.from))
      .filter(Boolean)
    : [];
  const outboundNodes = activeNode
    ? WORKFLOW_CANVAS_EDGES
      .filter((edge) => edge.from === activeNode.id)
      .map((edge) => allNodes.find((node) => node.id === edge.to))
      .filter(Boolean)
    : [];
  const inspector = activeDetail && activeNode ? `
    <aside class="workflow-inspector-panel workflow-inspector-popover" aria-label="${escapeHtml(activeNode.title)}配置">
      <div class="workflow-inspector-tabs">
        <button class="active" type="button">节点设置</button>
        <button type="button">运行信息</button>
      </div>
      <div class="workflow-inspector-scroll">
          <header class="workflow-inspector-node">
            <span>${icon(activeNode.iconName)}</span>
            <div><strong>${escapeHtml(activeNode.title)}</strong><small>${escapeHtml(activeDetail.description)}</small></div>
            <i aria-label="节点可用"></i>
          </header>
          <section class="workflow-inspector-section">
            <h3>基本信息</h3>
            <label><span>节点名称</span><input value="${escapeHtml(activeNode.title)}" readonly /></label>
            <label><span>节点描述</span><textarea readonly>${escapeHtml(activeDetail.description)}</textarea></label>
          </section>
          <section class="workflow-inspector-section">
            <h3>输入</h3>
            <div class="workflow-inspector-node-list">
              ${inboundNodes.length
                ? inboundNodes.map((node) => `<span>${icon(node.iconName)}<strong>${escapeHtml(node.title)}</strong></span>`).join("")
                : `<span class="empty">当前节点没有上游输入</span>`}
            </div>
          </section>
          <section class="workflow-inspector-section">
            <h3>${activeNode.kind === "output" ? "输出方式" : activeNode.kind === "source" ? "接入方式" : "处理配置"}</h3>
            <div class="workflow-inspector-options">
              ${activeDetail.options.map((option) => workflowRouteLink(option)).join("")}
            </div>
          </section>
          ${outboundNodes.length ? `
            <section class="workflow-inspector-section">
              <h3>输出</h3>
              <div class="workflow-inspector-node-list">
                ${outboundNodes.map((node) => `<span>${icon(node.iconName)}<strong>${escapeHtml(node.title)}</strong></span>`).join("")}
              </div>
            </section>
          ` : ""}
          <button class="workflow-inspector-close" data-close-workflow-inspector>${icon("close")}取消选择</button>
      </div>
    </aside>
  ` : "";
  return `
    <header class="workflow-topbar">
      <div class="workflow-topbar-identity">
        <div>
          <h1>自动生成凭证流程</h1>
          <span class="workflow-save-state">${icon("check")}已保存</span>
        </div>
        <small>本地凭证工作区</small>
      </div>
      <div class="workflow-topbar-actions">
        <button class="workflow-topbar-secondary" type="button" data-validate-workflow>
          ${icon("shield")}校验流程
        </button>
        <button class="workflow-topbar-primary" type="button" data-route="vouchers">
          ${icon("play")}生成凭证
        </button>
        <button class="workflow-topbar-more" type="button" data-open-runtime-status aria-label="查看系统状态" title="系统状态">
          ${icon("settings")}
        </button>
      </div>
    </header>
    <section class="workflow-canvas-shell" aria-label="可拖拽凭证数据流画布">
      <div class="workflow-canvas-body">
        <div class="workflow-canvas-main">
          <div class="workflow-canvas-viewport" data-workflow-canvas-viewport>
            <div class="workflow-stage-headings" aria-label="流程步骤">
              <section class="workflow-stage-heading"><strong>数据来源</strong></section>
              <section class="workflow-stage-heading"><strong>数据处理</strong></section>
              <section class="workflow-stage-heading"><strong>数据输出</strong></section>
            </div>
            <div class="workflow-canvas-surface" data-workflow-canvas>
              <svg class="workflow-canvas-connections" aria-hidden="true">
                <defs>
                  <marker id="workflow-canvas-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z"></path>
                  </marker>
                </defs>
                ${WORKFLOW_CANVAS_EDGES.map((edge) => `
                  <path
                    class="workflow-canvas-edge workflow-canvas-edge-${edge.tone}"
                    data-edge-from="${edge.from}"
                    data-edge-to="${edge.to}"
                    marker-end="url(#workflow-canvas-arrow)"
                  ></path>
                  <path
                    class="workflow-canvas-edge-flow workflow-canvas-edge-flow-${edge.tone}"
                    data-edge-from="${edge.from}"
                    data-edge-to="${edge.to}"
                  ></path>
                  <path
                    class="workflow-canvas-edge-hit"
                    data-edge-from="${edge.from}"
                    data-edge-to="${edge.to}"
                  ></path>
                `).join("")}
              </svg>
              ${allNodes.map((node) => canvasNode(node)).join("")}
            </div>
            <div class="workflow-canvas-tools" aria-label="画布工具">
              <button class="active" type="button" aria-label="选择节点">${icon("pointer")}</button>
              <button type="button" data-canvas-fit aria-label="适应画布">${icon("expand")}</button>
              <button type="button" aria-label="锁定布局">${icon("lock")}</button>
            </div>
            <div class="workflow-canvas-minimap" aria-label="流程小地图">
              <div class="workflow-minimap-stage-labels"><span>1</span><span>2</span><span>3</span></div>
              <div class="workflow-minimap-map">
                ${allNodes.map((node) => {
                  const position = workflowCanvasPositions[node.id] || WORKFLOW_CANVAS_DEFAULT_POSITIONS[node.id];
                  return `<i class="workflow-minimap-node workflow-minimap-node-${node.kind}" data-minimap-node="${escapeHtml(node.id)}" style="left:${(position.x * 100).toFixed(2)}%;top:${(position.y * 100).toFixed(2)}%"></i>`;
                }).join("")}
                <span class="workflow-minimap-viewport"></span>
              </div>
              <div class="workflow-minimap-zoom">
                <button type="button" data-minimap-zoom-out aria-label="缩小画布">−</button>
                <button type="button" data-minimap-zoom-in aria-label="放大画布">+</button>
              </div>
            </div>
          </div>
        </div>
        ${inspector}
      </div>
    </section>
  `;
}

function importPage() {
  return `
    <section class="page-heading import-page-heading ${pendingFiles.length ? "compact" : ""}">
      <div><span class="eyebrow">P0 本地文件闭环</span><h1>导入业务数据</h1><p>文件由本机服务解析并归档；导入前可确认字段，内容哈希重复时不会创建第二份资料。</p></div>
      <div class="heading-actions">
        <button class="secondary-button" data-download-master-template>${icon("download")}基础资料模板</button>
        <button class="secondary-button" data-download-template>${icon("download")}业务数据模板</button>
      </div>
    </section>
    <section class="import-grid ${pendingFiles.length ? "has-selection" : ""}">
      <article class="drop-panel glass-panel">
        <input id="file-input" type="file" multiple accept=".csv,.txt,.xls,.xlsx,.xml,.xbrl,.ofd,.pdf,.png,.jpg,.jpeg" hidden />
        <input id="folder-input" type="file" multiple webkitdirectory directory hidden />
        ${pendingFiles.length ? `
          <div class="selected-source-panel">
            <div class="selected-source-heading">
              <span class="selected-source-step">1</span>
              <div><span class="eyebrow">文件来源</span><h2>已选择 ${pendingFiles.length} 个文件</h2></div>
            </div>
            <div class="file-list selected-file-list">
              ${pendingFiles.map((item, index) => `
                <div>
                  <span class="file-icon">${icon("file")}</span>
                  <p><strong>${escapeHtml(item.file.name)}</strong><small>${item.kind} · ${(item.file.size / 1024).toFixed(1)} KB</small></p>
                  <button data-remove-file="${index}" aria-label="移除 ${escapeHtml(item.file.name)}">${icon("close")}</button>
                </div>
              `).join("")}
            </div>
            ${importPreview ? `
              <dl class="source-file-facts">
                <div><dt>源文件字段</dt><dd>${importPreview.sourceHeaders.length}</dd></div>
                <div><dt>系统处理字段</dt><dd>${importPreview.derivedHeaders.length}</dd></div>
                <div><dt>预计处理</dt><dd>${escapeHtml(pendingFiles[0]?.action || "本地解析")}</dd></div>
              </dl>
            ` : ""}
            <div class="selected-source-actions">
              <button class="secondary-button" data-choose-files>${icon("plus")}继续添加</button>
              <button class="quiet-button" data-choose-folder>添加文件夹</button>
            </div>
          </div>
        ` : `
          <div class="drop-zone" data-drop-zone>
            <span>${icon("upload")}</span>
            <h2>拖入文件，或点击选择</h2>
            <p>CSV、TXT、XLS、XLSX 和通用字段型 XML 可直接生成事项；PDF 与图片先安全归档，再由本地 OCR 生成候选字段供人工确认。</p>
            <div class="drop-actions"><button class="primary-button" data-choose-files>选择文件</button><button class="secondary-button" data-choose-folder>选择文件夹</button></div>
          </div>
        `}
        <div class="privacy-note">${icon("shield")}不会上传云端；文本型 PDF 本地提取，扫描件和图片由本地 OCR 生成候选并等待人工确认。</div>
      </article>
      <article class="preview-panel glass-panel import-preview ${pendingFiles.length ? "is-ready" : ""}">
        ${pendingFiles.length ? `
          <div class="import-workspace-heading">
            <div class="selected-source-step">2</div>
            <div>
              <span class="eyebrow">导入前确认</span>
              <h2>${importPreview?.kind === "masterData" ? "确认基础资料" : "确认字段映射"}</h2>
              <p>${importPreview?.kind === "masterData"
                ? `识别到 ${importPreview.masterDataCount} 条科目 / 客商 / 辅助核算资料`
                : importPreview?.matchedTemplate
                ? `已匹配模板：${escapeHtml(importPreview.matchedTemplate.name)}`
                : importPreview
                ? `源文件 ${importPreview.sourceHeaders.length} 个字段${importPreview.derivedHeaders.length
                  ? ` · 系统生成 ${importPreview.derivedHeaders.length} 个处理字段`
                  : ""}`
                : "正在读取文件结构并准备字段映射。"}</p>
            </div>
          </div>
          <div class="import-workspace-scroll">
            ${importPreview ? `
            <div class="mapping-card">
              ${importPreview.kind !== "masterData" ? `
              ${importPreview.importProfile === "bankStatement" && importPreview.derivedHeaders.length ? `
                <div class="mapping-note">${icon("info")}<span>系统处理字段由银行借方、贷方等原始列自动生成，不会修改 Excel 文件。</span></div>
              ` : ""}
              <div class="mapping-section-heading">
                <div><strong>字段对应关系</strong><small>必填字段已标记；其余字段可按需选择。</small></div>
                <span>${escapeHtml(importPreview.filename)}</span>
              </div>
              <div class="mapping-grid">
                ${mappingFields.map(([key, label, required, mode]) => mode === "multiple"
                  ? paymentAmountMappingControl()
                  : `
                  <label><span>${label}${required ? " *" : ""}</span>
                    <select data-mapping-field="${key}">
                      <option value="">不导入</option>
                      <optgroup label="源文件字段">
                        ${importPreview.sourceHeaders.map((header) => `
                          <option value="${escapeHtml(header)}" ${fieldMapping[key] === header ? "selected" : ""}>${escapeHtml(header)}</option>
                        `).join("")}
                      </optgroup>
                      ${importPreview.derivedHeaders.length ? `
                        <optgroup label="系统处理字段">
                          ${importPreview.derivedHeaders.map((header) => `
                            <option value="${escapeHtml(header)}" ${fieldMapping[key] === header ? "selected" : ""}>${escapeHtml(header)}</option>
                          `).join("")}
                        </optgroup>
                      ` : ""}
                    </select>
                  </label>
                `).join("")}
              </div>
              <label class="template-name"><span>模板名称（选填）</span><input data-template-name value="${escapeHtml(mappingTemplateName)}" placeholder="例如：招商银行流水 2026" /></label>` : ""}
              <section class="mapping-preview-section">
                <div class="mapping-section-heading">
                  <div><strong>数据样例</strong><small>展示源文件前 4 列、前 3 行，仅用于核对。</small></div>
                </div>
                <div class="sample-table">
                  <div class="sample-row sample-head">${importPreview.sourceHeaders.slice(0, 4).map((header) => `<span>${escapeHtml(header)}</span>`).join("")}</div>
                  ${importPreview.sampleRows.slice(0, 3).map((row) => `
                    <div class="sample-row">${importPreview.sourceHeaders.slice(0, 4).map((header) => `<span>${escapeHtml(row[header] ?? "")}</span>`).join("")}</div>
                  `).join("")}
                </div>
              </section>
            </div>
            ` : ""}
            ${importPreviewError ? `
              <div class="inline-warning" role="alert">
                ${icon("alert")}
                <div><strong>字段预览失败，尚未导入</strong><small>${escapeHtml(importPreviewError)}</small></div>
              </div>
            ` : ""}
            ${importProgress ? `
              <div class="job-progress">
                <div><strong>${importProgress.status === "queued" ? "正在排队" : "正在本地处理"}</strong><span>${importProgress.progress?.percent || 0}%</span></div>
                <progress max="100" value="${importProgress.progress?.percent || 0}"></progress>
                <small>${escapeHtml(importProgress.progress?.currentFile || "准备任务")} · ${importProgress.progress?.processed || 0}/${importProgress.progress?.total || pendingFiles.length}</small>
              </div>
            ` : ""}
          </div>
          <div class="import-action-bar">
            <div><strong>${importPreviewError ? "请先修正预览问题" : "确认无误后开始导入"}</strong><small>原文件保留在本机，导入结果可在业务数据中查看。</small></div>
            <button class="primary-button" data-run-import ${importProgress || importPreviewLoading || importPreviewError ? "disabled" : ""}>${icon("check")}${importProgress ? "处理中…" : importPreviewLoading ? "正在预览…" : "确认并开始导入"}</button>
          </div>
        ` : `
          <div class="panel-heading"><div><span class="eyebrow">导入预览</span><h2>等待选择文件</h2></div></div>
          <div class="empty-state">${icon("file")}<p>选择文件后将在这里显示类型、大小和预计处理方式。</p></div>
        `}
      </article>
    </section>
    ${importResult ? `
      <section class="result-card glass-panel">
        <div><span class="result-number success">${importResult.success}</span><small>成功</small></div>
        <div><span class="result-number">${importResult.duplicate}</span><small>重复</small></div>
        <div><span class="result-number warning">${importResult.failed}</span><small>失败</small></div>
        <p>${escapeHtml(importResult.message)}</p>
        ${importResult.errors?.length ? `<button class="secondary-button" data-download-errors>${icon("download")}下载错误明细</button>` : ""}
        <button class="secondary-button" data-route="events">查看业务事项</button>
      </section>
    ` : ""}
  `;
}

const eventDataScopes = {
  all: {
    eyebrow: "资料关系与追溯",
    title: "业务事项",
    countLabel: "项本地业务记录",
    emptyLabel: "没有匹配的业务事项",
    importLabel: "继续取数",
  },
  bank: {
    eyebrow: "流水、回单与收付款关系",
    title: "银行数据",
    countLabel: "项银行数据",
    emptyLabel: "尚无银行流水或回单数据",
    importLabel: "导入银行数据",
  },
  business: {
    eyebrow: "发票、订单、费用与业务单据",
    title: "业务数据",
    countLabel: "项业务数据",
    emptyLabel: "尚无可展示的业务数据",
    importLabel: "导入业务数据",
  },
  depreciation: {
    eyebrow: "固定资产、待摊费用与期间数据",
    title: "折旧摊销",
    countLabel: "项折旧摊销数据",
    emptyLabel: "尚无折旧或摊销数据",
    importLabel: "导入折旧摊销数据",
  },
};

function eventEvidenceText(event) {
  const documents = (event.sourceDocumentIds || [])
    .map((id) => state.sourceDocuments.find((item) => item.id === id))
    .filter(Boolean);
  const sourceRecords = event.sourceRecords || [];
  return [
    event.type,
    event.summary,
    event.bankSerial,
    ...documents.flatMap((document) => [document.name, document.type]),
    ...sourceRecords.flatMap((record) => [
      record.documentType,
      record.referenceFields?.bankSerial,
    ]),
  ].filter(Boolean).join(" ");
}

function eventMatchesDataScope(event, scope) {
  if (scope === "all") return true;
  const evidence = eventEvidenceText(event);
  const isBank = isBankRecord(event);
  const isDepreciation = /(折旧|摊销|固定资产|待摊)/.test(evidence);
  if (scope === "bank") return isBank;
  if (scope === "depreciation") return isDepreciation;
  return event.sourceSystem !== "feishu" && !isBank && !isDepreciation;
}

function eventsPage(scope = "all") {
  const scopeDetails = eventDataScopes[scope] || eventDataScopes.all;
  const scopedEvents = state.events.filter((event) => eventMatchesDataScope(event, scope));
  const filtered = filterLocalRecords(
    scopedEvents,
    query,
    ["type", "counterparty", "reference", "status", "amountCents", "date", "company", "invoiceNo", "bankSerial"],
    QUERY_RENDER_LIMIT,
  );
  const selected = filtered.find((event) => event.id === state.selectedEventId) || filtered[0];
  return `
    <section class="page-heading compact">
      <div><span class="eyebrow">${scopeDetails.eyebrow}</span><h1>${scopeDetails.title}</h1><p>${filtered.length} ${scopeDetails.countLabel}</p></div>
      <div class="heading-actions">
        ${state.exceptions.some((item) => item.status === "待处理")
          ? `<button class="secondary-button" data-route="exceptions">${icon("alert")}处理识别异常</button>`
          : ""}
        <button class="primary-button" data-route="import">${icon("plus")}${scopeDetails.importLabel}</button>
      </div>
    </section>
    <section class="master-detail">
      <article class="master-list glass-panel">
        ${filtered.map((event) => eventRow(event, true)).join("") || `<div class="empty-state">${scopeDetails.emptyLabel}</div>`}
      </article>
      <article class="detail-card glass-panel">
        ${selected ? `
          <div class="panel-heading"><div><span class="eyebrow">${escapeHtml(selected.reference)}</span><h2>${escapeHtml(selected.type)}</h2></div><span class="status-pill ${statusTone(selected.status)}">${selected.status}</span></div>
          <dl class="detail-grid">
            <div><dt>交易对方</dt><dd>${escapeHtml(selected.counterparty)}</dd></div>
            <div><dt>业务日期</dt><dd>${selected.date}</dd></div>
            <div><dt>含税金额</dt><dd>${formatMoney(selected.amountCents)}</dd></div>
            <div><dt>匹配置信度</dt><dd>${selected.matchConfidence == null ? "待计算" : `${Math.round(selected.matchConfidence * 100)}%`}</dd></div>
            <div><dt>部门</dt><dd>${escapeHtml(selected.department)}</dd></div>
            <div><dt>项目</dt><dd>${escapeHtml(selected.project || "未填写")}</dd></div>
          </dl>
          <h3 class="subheading">来源资料</h3>
          <div class="source-chain">
            ${selected.sourceDocumentIds.map((id) => {
              const doc = state.sourceDocuments.find((item) => item.id === id);
              return doc ? `<div>${icon("file")}<span><strong>${escapeHtml(doc.name)}</strong><small>${escapeHtml(doc.type)} · ${escapeHtml(doc.hash)}${doc.extractionStatus === "text_extracted" ? " · 已提取文本" : doc.extractionStatus === "ocr_confirmed" ? " · OCR 已人工确认" : doc.extractionStatus === "ocr_candidates" ? " · OCR 候选待确认" : doc.extractionStatus === "pending_ocr" ? " · 待 OCR" : ""}</small></span></div>` : "";
            }).join("") || `<p class="muted-copy">当前事项来自导入行数据，尚无独立附件。</p>`}
          </div>
          <h3 class="subheading">处理时间线</h3>
          <div class="mini-timeline">
            <div class="done"><i></i><span><strong>已导入</strong><small>原始资料完成哈希校验</small></span></div>
            <div class="done"><i></i><span><strong>已匹配</strong><small>按单据号、客商与金额建立关系</small></span></div>
            <div class="${getVoucherForEvent(selected.id) ? "done" : ""}"><i></i><span><strong>凭证草稿</strong><small>${getVoucherForEvent(selected.id) ? "已生成并保留规则依据" : "等待生成"}</small></span></div>
          </div>
        ` : ""}
      </article>
    </section>
  `;
}

function vouchersPage() {
  const selected = getSelectedEvent();
  const queueEvents = filterLocalRecords(
    state.events,
    query,
    ["type", "counterparty", "reference", "status", "amountCents", "date", "company", "invoiceNo", "bankSerial"],
    QUERY_RENDER_LIMIT,
  );
  const batch = eligibleForBatchConfirmation(state);
  const batchAmount = batch.reduce((total, voucher) => total + validateVoucher(voucher).debitCents, 0);
  const generatable = state.events.filter((event) =>
    !getVoucherForEvent(event.id)
    && !event.exceptionIds.some((id) => state.exceptions.some((item) => item.id === id && item.status === "待处理")));
  const generationJob = state.batchGenerationJob;
  return `
    <section class="page-heading compact">
      <div><span class="eyebrow">来源证据与分录对照</span><h1>凭证草稿</h1><p>只有借贷平衡且无阻断异常的草稿才可人工确认。</p></div>
      <div class="heading-actions">
        ${generatable.length ? `<button class="secondary-button" data-batch-generate>${generationJob?.status === "running" ? "继续" : "批量生成"} ${generatable.length} 张草稿</button>` : ""}
        ${batch.length ? `<button class="primary-button" data-batch-approve>批量确认 ${batch.length} 张 · ${formatMoney(batchAmount)}</button>` : ""}
      </div>
    </section>
    ${generationJob ? `<div class="job-progress compact-job"><div><strong>${escapeHtml(generationJob.status === "completed" ? "批量生成完成" : "批量生成进度")}</strong><span>${generationJob.processed || 0}/${generationJob.total || 0}</span></div><progress max="100" value="${generationJob.percent || 0}"></progress><small>每完成一张即写入 SQLite，可在重启后继续未完成事项。</small></div>` : ""}
    <section class="voucher-workspace">
      <article class="voucher-queue glass-panel">
        ${queueEvents.map((event) => eventRow(event, true)).join("") || `<div class="empty-state compact-empty">${icon("search")}<p>没有匹配的凭证事项</p></div>`}
      </article>
      <article class="source-panel glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">原始资料</span><h2>${escapeHtml(selected?.reference || "")}</h2></div></div>
        <div class="source-summary">
          <strong>${escapeHtml(selected?.counterparty || "")}</strong>
          <span>${selected ? formatMoney(selected.amountCents) : ""}</span>
          <small>${selected?.date || ""} · ${escapeHtml(selected?.department || "")}</small>
        </div>
        <div class="source-chain">
          ${(selected?.sourceDocumentIds || []).map((id) => {
            const doc = state.sourceDocuments.find((item) => item.id === id);
            return doc ? `<div>${icon("file")}<span><strong>${escapeHtml(doc.name)}</strong><small>${escapeHtml(doc.type)} · SHA-256 ${escapeHtml(doc.hash)}${doc.extractionStatus === "text_extracted" ? " · 已提取文本" : doc.extractionStatus === "ocr_confirmed" ? " · OCR 已人工确认" : doc.extractionStatus === "ocr_candidates" ? " · OCR 候选待确认" : doc.extractionStatus === "pending_ocr" ? " · 待 OCR" : ""}</small></span></div>` : "";
          }).join("") || `<p class="muted-copy">暂无独立附件，来源为结构化导入行。</p>`}
        </div>
        <div class="match-explain"><strong>匹配解释</strong><p>${selected?.matchConfidence == null ? "尚无足够真实匹配证据，置信度保持为空。" : `业务编号、交易对方与金额共同匹配；当前置信度 ${Math.round(selected.matchConfidence * 100)}%。`}</p></div>
      </article>
      <article class="preview-panel glass-panel">${voucherPreview(selected, getVoucherForEvent(selected?.id))}</article>
    </section>
  `;
}

function deliveryPage() {
  const deliverable = state.vouchers.filter((voucher) => voucher.status === "已确认");
  const connectedTarget = state.connectors.find((connector) =>
    connector.id === state.activeFinanceConnectorId);
  return `
    <section class="page-heading compact">
      <div>
        <span class="eyebrow">输出端 · ERP</span>
        <h1>ERP 输出</h1>
        <p>选择目标 ERP，将当前可输出凭证发送到财务系统。</p>
      </div>
      <div class="heading-actions">
        <button class="secondary-button" data-route="connectors">${icon("link")}ERP 连接配置</button>
      </div>
    </section>
    <section class="output-destination glass-panel">
      <span class="output-destination-icon">${icon("link")}</span>
      <div><small>当前 ERP</small><strong>${escapeHtml(connectedTarget?.name || "尚未配置")}</strong><p>${escapeHtml(connectedTarget?.environment || "请先完成 ERP 连接配置")}</p></div>
      <span>${deliverable.length} 张可输出</span>
    </section>
    <section class="output-list glass-panel">
      <div class="panel-heading">
        <div><span class="eyebrow">可输出凭证</span><h2>选择凭证</h2></div>
      </div>
      ${deliverable.length ? deliverable.map((voucher) => {
        const validation = validateVoucher(voucher);
        return `
          <article class="output-row">
            <div class="output-row-main">
              <span><strong>${escapeHtml(voucher.number)}</strong><small>${escapeHtml(voucher.summary)} · ${voucher.accountingDate}</small></span>
              <strong>${formatMoney(validation.debitCents)}</strong>
            </div>
            <button class="primary-button" data-push="${voucher.id}" ${connectedTarget ? "" : "disabled"}>${icon("arrow")}输出到 ERP</button>
          </article>
        `;
      }).join("") : `
        <div class="empty-state">${icon("voucher")}<h3>暂无可输出凭证</h3><p>完成数据处理和凭证生成后，可在这里选择输出。</p><button class="secondary-button" data-route="vouchers">前往生成凭证</button></div>
      `}
    </section>
  `;
}

function templatesPage() {
  const exportable = state.vouchers.filter((voucher) => ["已确认", "已推送"].includes(voucher.status));
  return `
    <section class="page-heading compact">
      <div>
        <span class="eyebrow">输出端 · 凭证模板</span>
        <h1>凭证模板</h1>
        <p>选择凭证，导出通用 Excel 模板。</p>
      </div>
    </section>
    <section class="template-output-intro glass-panel">
      <span>${icon("download")}</span>
      <div><small>当前模板</small><strong>通用凭证 Excel</strong><p>包含凭证头、分录和辅助核算，可用于后续导入或归档。</p></div>
      <b>.xlsx</b>
    </section>
    <section class="output-list glass-panel">
      <div class="panel-heading">
        <div><span class="eyebrow">可导出凭证</span><h2>选择凭证</h2></div>
        <small>${exportable.length} 张</small>
      </div>
      ${exportable.length ? exportable.map((voucher) => {
        const validation = validateVoucher(voucher);
        return `
          <article class="output-row">
            <div class="output-row-main">
              <span><strong>${escapeHtml(voucher.number)}</strong><small>${escapeHtml(voucher.summary)} · ${voucher.accountingDate}</small></span>
              <strong>${formatMoney(validation.debitCents)}</strong>
            </div>
            <button class="secondary-button" data-export="${voucher.id}">${icon("download")}导出 Excel</button>
          </article>
        `;
      }).join("") : `
        <div class="empty-state">${icon("voucher")}<h3>暂无可导出凭证</h3><p>完成数据处理和凭证生成后，可在这里选择模板导出。</p><button class="secondary-button" data-route="vouchers">前往生成凭证</button></div>
      `}
    </section>
  `;
}

function exceptionsPage() {
  const items = filterLocalRecords(
    state.exceptions,
    query,
    ["type", "title", "detail", "severity", "status", "eventId"],
    QUERY_RENDER_LIMIT,
  );
  return `
    <section class="page-heading">
      <div><span class="eyebrow">把判断留给财务人员</span><h1>异常中心</h1><p>每个异常都说明发生了什么、为什么不能自动处理，以及下一步建议。</p></div>
      <span class="large-count">${items.filter((item) => item.status === "待处理").length}<small>待处理</small></span>
    </section>
    <section class="exception-list">
      ${items.map((item) => {
        const event = state.events.find((candidate) => candidate.id === item.eventId);
        const document = item.documentIds?.length
          ? state.sourceDocuments.find((candidate) => candidate.id === item.documentIds[0])
          : null;
        const candidates = document?.ocrCandidates || {};
        const ocrEditor = ["OCR 候选待确认", "文本候选待确认"].includes(item.type) && item.status === "待处理" ? `
          <div class="ocr-confirm-card">
            <div class="ocr-confidence"><strong>OCR 候选字段</strong><span>${Math.round((document.ocrConfidence || 0) * 100)}% 平均置信度</span></div>
            <div class="ocr-fields">
              <label><span>业务日期 *</span><input data-ocr-field="date" value="${escapeHtml(candidates.date || "")}" placeholder="YYYY-MM-DD" /></label>
              <label><span>供应商 / 客商 *</span><input data-ocr-field="counterparty" value="${escapeHtml(candidates.counterparty || "")}" placeholder="请人工核对主体名称" /></label>
              <label><span>含税金额 *</span><input data-ocr-field="amount" value="${escapeHtml(candidates.amount || "")}" /></label>
              <label><span>发票号码</span><input data-ocr-field="invoiceNo" value="${escapeHtml(candidates.invoiceNo || "")}" /></label>
              <label><span>销售方税号</span><input data-ocr-field="sellerTaxId" value="${escapeHtml(candidates.sellerTaxId || "")}" /></label>
              <label><span>审批单号 / 事项编号</span><input data-ocr-field="reference" value="${escapeHtml(candidates.invoiceNo || "")}" /></label>
            </div>
            ${document.lowConfidenceFields?.length ? `<p class="ocr-warning">以下字段置信度偏低，必须人工复核：${document.lowConfidenceFields.map(escapeHtml).join("、")}</p>` : ""}
            <button class="primary-button" data-confirm-ocr="${item.id}">${icon("check")}确认候选并创建事项</button>
          </div>
        ` : "";
        const sourceAmounts = event?.sourceRecords
          ?.map((record) => record.amountCents)
          .filter((amount) => Number.isInteger(amount) && amount > 0) || [];
        const suggestedSettledCents = sourceAmounts.length
          ? (Math.max(...sourceAmounts) > event.amountCents ? event.amountCents : Math.min(...sourceAmounts))
          : 0;
        const amountEditor = item.type === "金额不一致" && event && item.status === "待处理" ? `
          <div class="ocr-confirm-card">
            <div class="ocr-confidence"><strong>部分付款 / 拆单确认</strong><span>必须由财务人员判断</span></div>
            <div class="allocation-fields">
              <label><span>本次确认入账金额 *</span><input data-allocation-amount value="${suggestedSettledCents ? (suggestedSettledCents / 100).toFixed(2) : ""}" /></label>
              <label class="check-row"><input type="checkbox" data-create-residual checked />将剩余金额创建为待匹配事项</label>
            </div>
            <p class="ocr-warning">系统不会猜测差额性质；确认后保留原金额、本次金额、剩余金额和操作者记录。</p>
            <button class="primary-button" data-confirm-allocation="${item.id}">${icon("check")}确认拆分并重新校验</button>
          </div>
        ` : "";
        return `
          <article class="exception-card glass-panel ${item.status === "已解决" ? "resolved" : ""}">
            <span class="severity ${item.severity === "阻断" ? "blocking" : ""}">${item.severity}</span>
            <div class="exception-copy"><span class="eyebrow">${escapeHtml(item.type)}</span><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.detail)}</p><div class="suggestion"><strong>推荐操作</strong>${escapeHtml(item.suggestion)}</div>${ocrEditor}${amountEditor}${event ? `<button class="text-button" data-open-event="${event.id}">查看 ${escapeHtml(event.reference)} ${icon("arrow")}</button>` : ""}</div>
            <div class="exception-action"><span class="status-pill ${statusTone(item.status)}">${item.status}</span>${item.status === "待处理" && !["OCR 候选待确认", "文本候选待确认", "金额不一致"].includes(item.type) ? `<button class="primary-button" data-resolve="${item.id}">${icon("check")}标记已解决</button>` : ""}</div>
          </article>
        `;
      }).join("")}
    </section>
  `;
}

function queryPage() {
  const ledger = buildLedger(state.vouchers);
  const realFinanceConnectors = state.connectors.filter((item) =>
    item.type === "finance" && item.status === "connected");
  const latestExternalQueries = (state.externalQueryCache || []).slice(0, 20);
  const externalReads = (state.externalReadCache || []).slice(0, 20);
  const ledgerConnectors = realFinanceConnectors.filter((item) => item.capabilities?.includes("query_ledger"));
  const reportConnectors = realFinanceConnectors.filter((item) => item.capabilities?.includes("query_financial_reports"));
  const latestRead = externalReads[0];
  const localTotal = state.vouchers
    .filter((voucher) => ["已确认", "已推送"].includes(voucher.status))
    .reduce((sum, voucher) => sum + validateVoucher(voucher).debitCents, 0);
  return `
    <section class="page-heading">
      <div><span class="eyebrow">查询与双向追溯</span><h1>查询中心</h1><p>本地汇总与目标系统实时回查明确分开；未连接真实财务系统时不伪造外部查询结果。</p></div>
      <span class="cache-chip">本地缓存 · ${formatDate(state.lastSavedAt, true)}</span>
    </section>
    <section class="query-tabs">
      <button class="${queryView === "vouchers" ? "active" : ""}" data-query-view="vouchers">凭证与追溯</button>
      <button class="${queryView === "sources" ? "active" : ""}" data-query-view="sources">原始资料 / 事项</button>
      <button class="${queryView === "ledger" ? "active" : ""}" data-query-view="ledger">本地账簿</button>
      <button class="${queryView === "external" ? "active" : ""}" data-query-view="external">外部凭证</button>
      <button class="${queryView === "externalReports" ? "active" : ""}" data-query-view="externalReports">外部账簿 / 报表</button>
      <button class="${queryView === "audit" ? "active" : ""}" data-query-view="audit">操作日志</button>
    </section>
    <section class="report-metrics">
      <article class="glass-panel"><span>本地凭证</span><strong>${state.vouchers.length}</strong><small>含草稿和已推送</small></article>
      <article class="glass-panel"><span>已确认借方发生额</span><strong>${formatMoney(localTotal)}</strong><small>本地预估数据</small></article>
      <article class="glass-panel"><span>外部回查成功</span><strong>${state.vouchers.filter((item) => item.externalReference).length}</strong><small>真实目标系统回查</small></article>
    </section>
    ${queryView === "vouchers" ? `<section class="query-grid">
      <article class="table-panel glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">凭证列表</span><h2>本地凭证与外部状态</h2></div></div>
        <div class="data-table">
          <div class="data-tr data-th"><span>凭证号</span><span>日期</span><span>摘要</span><span>借方</span><span>状态</span></div>
          ${state.vouchers.slice(0, QUERY_RENDER_LIMIT).map((voucher) => {
            const validation = validateVoucher(voucher);
            return `<button class="data-tr" data-open-voucher="${voucher.sourceEventIds[0]}"><strong>${escapeHtml(voucher.number)}</strong><span>${voucher.accountingDate}</span><span>${escapeHtml(voucher.summary)}</span><span>${formatMoney(validation.debitCents)}</span><span class="status-pill ${statusTone(voucher.status)}">${voucher.status}</span></button>`;
          }).join("")}
        </div>
        ${state.vouchers.length > QUERY_RENDER_LIMIT ? `<p class="render-limit-note">为保证桌面端大数据量流畅，仅渲染最近 ${QUERY_RENDER_LIMIT} 条；请使用全局搜索缩小范围。</p>` : ""}
      </article>
      <article class="ledger-panel glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">本地预估</span><h2>科目余额</h2></div></div>
        ${ledger.length ? ledger.map((row) => `
          <div class="ledger-row"><span><strong>${row.accountCode} ${escapeHtml(row.accountName)}</strong><small>最后发生 ${row.latestDate}</small></span><strong>${formatMoney(Math.abs(row.balanceCents))}</strong><small>${row.balanceCents >= 0 ? "借" : "贷"}</small></div>
        `).join("") : `<div class="empty-state">确认凭证后显示本地科目汇总</div>`}
      </article>
    </section>` : ""}
    ${queryView === "sources" ? `
      <section class="query-grid">
        <article class="table-panel glass-panel">
          <div class="panel-heading"><div><span class="eyebrow">原始资料</span><h2>归档与关联</h2></div></div>
          <div class="source-query-list">${state.sourceDocuments.filter((document) =>
            `${document.name} ${document.type} ${document.hash}`.toLowerCase().includes(query.toLowerCase())).slice(0, QUERY_RENDER_LIMIT).map((document) => {
              const linked = state.events.filter((event) => event.sourceDocumentIds.includes(document.id));
              return `<div><span>${icon("file")}<strong>${escapeHtml(document.name)}</strong><small>${escapeHtml(document.type)} · SHA-256 ${escapeHtml(document.hash)}</small></span>
                <span>${linked.map((event) => `<button class="text-button" data-open-event="${event.id}">${escapeHtml(event.reference)}</button>`).join("") || "尚未关联事项"}</span></div>`;
            }).join("")}</div>
        </article>
        <article class="ledger-panel glass-panel">
          <div class="panel-heading"><div><span class="eyebrow">业务事项</span><h2>双向追溯</h2></div></div>
          ${state.events.filter((event) =>
            `${event.reference} ${event.counterparty} ${event.type}`.toLowerCase().includes(query.toLowerCase())).slice(0, QUERY_RENDER_LIMIT).map((event) =>
              `<button class="trace-row" data-open-event="${event.id}"><span><strong>${escapeHtml(event.reference)}</strong><small>${escapeHtml(event.counterparty)} · ${event.sourceDocumentIds.length} 份资料</small></span><span class="status-pill ${statusTone(event.status)}">${escapeHtml(event.status)}</span></button>`).join("")}
        </article>
      </section>
    ` : ""}
    ${queryView === "ledger" ? `
      <section class="ledger-full glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">本地预估 · 非法定总账</span><h2>科目发生额与余额</h2></div></div>
        ${ledger.map((row) => `<div class="ledger-row"><span><strong>${row.accountCode} ${escapeHtml(row.accountName)}</strong><small>最后发生 ${row.latestDate}</small></span><strong>借 ${formatMoney(row.debitCents)}</strong><strong>贷 ${formatMoney(row.creditCents)}</strong><strong>${formatMoney(Math.abs(row.balanceCents))} ${row.balanceCents >= 0 ? "借" : "贷"}</strong></div>`).join("") || `<div class="empty-state">确认凭证后显示本地科目汇总</div>`}
      </section>
    ` : ""}
    ${queryView === "external" ? `
      <section class="external-query-layout">
        <article class="settings-card glass-panel">
          <div class="panel-heading"><div><span class="eyebrow">目标系统实时读取</span><h2>查询外部凭证</h2></div></div>
          ${realFinanceConnectors.length ? `
            <form class="external-query-form" data-external-query-form>
              <label><span>财务连接器</span><select name="connectorId">${realFinanceConnectors.map((connector) =>
                `<option value="${connector.id}">${escapeHtml(connector.name)} · ${escapeHtml(connector.environment)}</option>`).join("")}</select></label>
              <label><span>外部凭证号</span><input name="number" placeholder="例如：记-0088" /></label>
              <label><span>或幂等引用</span><input name="reference" placeholder="系统生成的幂等引用" /></label>
              <button class="primary-button" type="submit">${icon("search")}实时查询</button>
            </form>
            <p class="query-source-note">${icon("shield")}查询结果来自目标系统实时接口，并记录连接器、环境和查询时间。</p>
          ` : `<div class="empty-state">先在“连接器”页面配置并通过真实财务连接器测试，才会开放外部查询。</div>`}
        </article>
        <article class="table-panel glass-panel">
          <div class="panel-heading"><div><span class="eyebrow">最多保留 100 次</span><h2>最近外部回查</h2></div></div>
          ${latestExternalQueries.length ? `<div class="external-query-results">${latestExternalQueries.map((item) => `
            <div>
              <span><strong>${escapeHtml(item.query?.number || item.query?.reference)}</strong><small>${escapeHtml(item.connectorName)} · ${escapeHtml(item.environment)} · ${formatDate(item.queriedAt, true)}</small></span>
              ${item.found ? `<span><strong>${escapeHtml(item.voucher?.externalNumber || item.voucher?.externalId)}</strong><small>外部 ID ${escapeHtml(item.voucher?.externalId)} · ${escapeHtml(item.voucher?.status || "状态未知")}</small></span>` : `<span class="status-pill warning">未找到</span>`}
            </div>
          `).join("")}</div>` : `<div class="empty-state">尚无外部查询记录</div>`}
        </article>
      </section>
    ` : ""}
    ${queryView === "externalReports" ? `
      <section class="external-read-layout">
        <article class="settings-card glass-panel">
          <div class="panel-heading"><div><span class="eyebrow">目标系统实时读取</span><h2>账簿查询</h2></div></div>
          ${ledgerConnectors.length ? `<form class="external-query-form" data-external-ledger-form>
            <label><span>财务连接器</span><select name="connectorId">${ledgerConnectors.map((connector) => `<option value="${connector.id}">${escapeHtml(connector.name)} · ${escapeHtml(connector.environment)}</option>`).join("")}</select></label>
            <label><span>账簿</span><input name="ledger" value="${escapeHtml(state.ledger)}" required /></label>
            <label><span>会计期间</span><input name="period" value="2026-07" required /></label>
            <label><span>科目（可选）</span><input name="account" /></label>
            <label><span>辅助维度（可选）</span><input name="dimension" /></label>
            <button class="primary-button" type="submit">${icon("search")}查询余额与明细</button>
          </form>` : `<div class="empty-state">当前连接器未探测到账簿查询能力。请先配置目标版本的只读查询模型并重新测试连接。</div>`}
        </article>
        <article class="settings-card glass-panel">
          <div class="panel-heading"><div><span class="eyebrow">正式报表以目标系统为准</span><h2>三大财务报表</h2></div></div>
          ${reportConnectors.length ? `<form class="external-query-form" data-external-report-form>
            <label><span>财务连接器</span><select name="connectorId">${reportConnectors.map((connector) => `<option value="${connector.id}">${escapeHtml(connector.name)} · ${escapeHtml(connector.environment)}</option>`).join("")}</select></label>
            <label><span>报表</span><select name="reportType"><option value="balanceSheet">资产负债表</option><option value="incomeStatement">利润表</option><option value="cashFlow">现金流量表</option></select></label>
            <label><span>会计期间</span><input name="period" value="2026-07" required /></label>
            <button class="primary-button" type="submit">${icon("search")}查询正式报表</button>
          </form>` : `<div class="empty-state">当前连接器未同时探测到资产负债表、利润表和现金流量表查询能力。</div>`}
        </article>
      </section>
      <section class="table-panel glass-panel external-read-result">
        <div class="panel-heading"><div><span class="eyebrow">${latestRead ? `${escapeHtml(latestRead.connectorName)} · ${escapeHtml(latestRead.environment)} · ${formatDate(latestRead.queriedAt, true)}` : "目标系统实时结果"}</span><h2>${escapeHtml(latestRead?.label || "尚无外部账簿或报表结果")}</h2></div></div>
        ${latestRead ? `<div class="external-data-table">
          <div class="external-data-row external-data-head">${latestRead.fields.map((field) => `<span>${escapeHtml(field)}</span>`).join("")}</div>
          ${latestRead.rows.slice(0, QUERY_RENDER_LIMIT).map((row) => `<div class="external-data-row">${latestRead.fields.map((field) => `<span>${escapeHtml(row[field])}</span>`).join("")}</div>`).join("")}
        </div><p class="query-source-note">${icon("shield")}来源：目标财务系统实时只读接口；查询参数 ${escapeHtml(JSON.stringify(latestRead.parameters))}</p>` : `<div class="empty-state">执行查询后在这里显示字段、口径、来源、环境和同步时间。</div>`}
      </section>
    ` : ""}
    ${queryView === "audit" ? `<section class="activity-panel glass-panel">
      <div class="panel-heading"><div><span class="eyebrow">只追加审计日志</span><h2>操作记录</h2></div></div>
      <div class="activity-list">${state.auditLog.filter((log) =>
        `${log.action} ${log.subject} ${log.detail} ${log.operator}`.toLowerCase().includes(query.toLowerCase())).slice(0, QUERY_RENDER_LIMIT).map((log) => `<div><span class="activity-dot"></span><p><strong>${escapeHtml(log.action)} · ${escapeHtml(log.subject)}</strong><small>${escapeHtml(log.detail)} · 操作者 ${escapeHtml(log.operator)}</small></p><time>${formatDate(log.at, true)}</time></div>`).join("")}</div>
    </section>` : ""}
  `;
}

const ruleSummaryTokens = ["摘要", "供应商/客商", "业务日期", "单据号", "部门", "项目", "币别"];

const ruleSpecOptions = {
  currency: {
    fields: [["currency", "来源币别"]],
    calculations: [
      ["baseCurrency", "使用金蝶本位币"],
      ["previousLineCurrency", "沿用上一行币别"],
    ],
    placeholder: "例如 PRE001",
  },
  exchangeRateType: {
    fields: [["exchangeRateType", "业务数据中的汇率类型（高级）"]],
    calculations: [
      ["defaultRateType", "金蝶默认汇率类型"],
      ["previousLineExchangeRateType", "沿用上一行汇率类型"],
    ],
    placeholder: "例如 001",
  },
  exchangeRate: {
    fields: [
      ["kingdeeExchangeRate", "金蝶汇率体系匹配"],
      ["exchangeRate", "来源汇率字段"],
    ],
    calculations: [
      ["rateOne", "固定按 1 计算"],
      ["inverseKingdeeRate", "金蝶汇率取倒数"],
      ["previousLineExchangeRate", "沿用上一行汇率"],
    ],
    placeholder: "例如 0.0174",
    numeric: true,
  },
  originalAmount: {
    fields: [
      ["amount", "业务金额"],
      ["grossAmount", "含税金额"],
      ["netAmount", "不含税金额"],
      ["taxAmount", "税额"],
      ["paymentAmount", "付款金额"],
    ],
    calculations: [
      ["netPlusTax", "不含税金额 + 税额"],
      ["grossMinusTax", "含税金额 - 税额"],
    ],
    placeholder: "例如 708.00",
    numeric: true,
  },
  localAmount: {
    fields: [
      ["amount", "业务金额"],
      ["grossAmount", "含税金额"],
      ["netAmount", "不含税金额"],
      ["taxAmount", "税额"],
      ["paymentAmount", "付款金额"],
    ],
    calculations: [
      ["originalAmount", "等于原币金额"],
      ["originalTimesRate", "原币金额 × 汇率"],
      ["originalDivideRate", "原币金额 ÷ 汇率"],
    ],
    placeholder: "留空或 0 表示本方向不记账",
    numeric: true,
  },
  department: {
    fields: [["department", "来源部门"]],
    calculations: [["previousLineValue", "沿用上一行"]],
    placeholder: "固定部门编码",
  },
  project: {
    fields: [["project", "来源项目"]],
    calculations: [["previousLineValue", "沿用上一行"]],
    placeholder: "固定项目编码",
  },
  supplier: {
    fields: [["counterparty", "来源供应商 / 客商"]],
    calculations: [["previousLineValue", "沿用上一行"]],
    placeholder: "固定供应商编码",
  },
  dimension: {
    fields: [
      ["counterparty", "来源供应商 / 客户 / 对方单位"],
      ["department", "来源部门"],
      ["project", "来源项目"],
    ],
    calculations: [["previousLineValue", "沿用上一行"]],
    placeholder: "固定主数据编码或精确名称",
  },
};

function ruleSpec(mode = "fixed", value = "", field = "", calculation = "") {
  return { mode, value, field, calculation };
}

function normalizeExchangeRateTypeSpec(spec) {
  const source = spec && typeof spec === "object"
    ? {
        mode: spec.mode || "",
        value: spec.value ?? "",
        field: spec.field || "",
        calculation: spec.calculation || "",
      }
    : ruleSpec("fixed", spec ?? "");
  const hasConfiguredSource = source.mode === "fixed"
    ? String(source.value).trim()
    : source.mode === "field"
      ? String(source.field).trim()
      : source.mode === "calculation"
        ? String(source.calculation).trim()
        : "";
  return hasConfiguredSource
    ? source
    : ruleSpec("calculation", "", "", "defaultRateType");
}

function defaultDimensionBinding(key, required = false) {
  const definition = AUXILIARY_DIMENSION_CATALOG.find((item) => item.key === key);
  return {
    key,
    required,
    valueSpec: definition?.defaultField
      ? ruleSpec("field", "", definition.defaultField)
      : ruleSpec("fixed"),
  };
}

function blankRulePostingLine(side = "debit") {
  const dimensionBindings = [
    defaultDimensionBinding("department"),
    defaultDimensionBinding("project"),
    defaultDimensionBinding("supplier", side === "credit"),
  ];
  return {
    summaryTemplate: side === "debit" ? "{摘要}" : "确认往来 · {供应商/客商}",
    accountCode: "",
    accountName: "",
    accountSource: { mode: "fixed", field: "" },
    dimensions: {
      department: ruleSpec("field", "", "department"),
      project: ruleSpec("field", "", "project"),
      supplier: ruleSpec("field", "", "counterparty"),
    },
    requiredDimensions: side === "credit" ? ["supplier"] : [],
    dimensionBindings,
    currency: ruleSpec("field", "", "currency"),
    exchangeRateType: ruleSpec("calculation", "", "", "defaultRateType"),
    exchangeRate: ruleSpec("field", "", "kingdeeExchangeRate"),
    originalAmount: ruleSpec("field", "", "amount"),
    debitAmount: side === "debit"
      ? ruleSpec("calculation", "", "", "originalTimesRate")
      : ruleSpec("fixed", "0"),
    creditAmount: side === "credit"
      ? ruleSpec("calculation", "", "", "originalTimesRate")
      : ruleSpec("fixed", "0"),
  };
}

function normalizeRulePostingLine(line, side = "debit") {
  const fallback = blankRulePostingLine(side);
  const merged = {
    ...fallback,
    ...JSON.parse(JSON.stringify(line || {})),
    dimensions: {
      ...fallback.dimensions,
      ...(line?.dimensions || {}),
    },
    requiredDimensions: [...(line?.requiredDimensions || fallback.requiredDimensions)],
  };
  const dimensionBindings = normalizeDimensionBindings(merged);
  return {
    ...merged,
    accountSource: {
      mode: merged.accountSource?.mode === "field" ? "field" : "fixed",
      field: merged.accountSource?.mode === "field"
        ? String(merged.accountSource?.field || "debitAccount")
        : "",
    },
    exchangeRateType: normalizeExchangeRateTypeSpec(merged.exchangeRateType),
    dimensionBindings,
    dimensions: Object.fromEntries(
      dimensionBindings.map((binding) => [binding.key, binding.valueSpec]),
    ),
    requiredDimensions: dimensionBindings
      .filter((binding) => binding.required)
      .map((binding) => binding.key),
  };
}

function ruleDraftFromRule(rule = null) {
  if (!rule) {
    return {
      name: "",
      priority: 70,
      match: { businessType: "采购付款", counterparty: "" },
      posting: { lines: [blankRulePostingLine("debit"), blankRulePostingLine("credit")] },
    };
  }
  const copy = JSON.parse(JSON.stringify(rule));
  if (!Array.isArray(copy.posting?.lines) || !copy.posting.lines.length) {
    copy.posting.lines = [
      normalizeRulePostingLine({
        summaryTemplate: "{摘要}",
        accountCode: copy.posting?.debitAccountCode || "",
        accountName: copy.posting?.debitAccountName || "",
      }, "debit"),
      normalizeRulePostingLine({
        summaryTemplate: "确认往来 · {供应商/客商}",
        accountCode: copy.posting?.creditAccountCode || "",
        accountName: copy.posting?.creditAccountName || "",
      }, "credit"),
    ];
  } else {
    copy.posting.lines = copy.posting.lines.map((line, index) =>
      normalizeRulePostingLine(line, index === 0 ? "debit" : "credit"));
  }
  return copy;
}

function selectedOption(value, current) {
  return value === current ? "selected" : "";
}

function ruleSpecDescription(spec, kind) {
  const source = kind === "exchangeRateType"
    ? normalizeExchangeRateTypeSpec(spec)
    : spec || ruleSpec();
  const config = ruleSpecOptions[kind] || ruleSpecOptions.dimension;
  const value = String(source.value ?? "").trim();
  if (source.mode === "field") {
    return config.fields.find(([field]) => field === source.field)?.[1] || "请选择来源字段";
  }
  if (source.mode === "calculation") {
    return config.calculations.find(([calculation]) => calculation === source.calculation)?.[1]
      || "请选择计算方式";
  }
  if (!value || (kind === "localAmount" && Number(value) === 0)) return "—";
  return `固定 ${value}`;
}

function ruleDimensionSummary(line) {
  const labels = normalizeDimensionBindings(line).map((binding) =>
    `${binding.label}${binding.required ? "（必填）" : ""}`);
  return labels.length ? labels.join("、") : "未配置";
}

function ruleLineStatus(line) {
  if (
    line.accountSource?.mode === "field"
      ? line.accountSource.field !== "debitAccount"
      : !line.accountCode || !line.accountName
  ) return "待选择科目";
  if (!line.summaryTemplate) return "待填写摘要";
  return "已配置";
}

function ruleAccountCodeDescription(line) {
  return line.accountSource?.mode === "field"
    ? "审批处理科目"
    : line.accountCode || "点击选择";
}

function ruleAccountNameDescription(line) {
  return line.accountSource?.mode === "field"
    ? "来源字段"
    : line.accountName || "点击选择";
}

function ruleValueSourceControl(index, key, spec, kind) {
  const source = spec || ruleSpec();
  const config = ruleSpecOptions[kind] || ruleSpecOptions.dimension;
  const mode = source.mode || "fixed";
  const modes = [
    ["fixed", "固定值"],
    ["field", "来源字段"],
    ["calculation", "简单计算"],
  ];
  let editor = "";
  if (mode === "fixed") {
    editor = `<input
      data-rule-line-spec-value="${key}"
      ${config.numeric ? 'inputmode="decimal"' : ""}
      ${kind === "currency" ? 'list="currency-code-options"' : ""}
      value="${escapeHtml(source.value || "")}"
      placeholder="${escapeHtml(config.placeholder)}"
    />`;
  } else if (mode === "field") {
    editor = `<select data-rule-line-spec-field="${key}">
      <option value="">请选择来源字段</option>
      ${config.fields.map(([value, label]) =>
        `<option value="${value}" ${selectedOption(value, source.field)}>${label}</option>`).join("")}
    </select>`;
  } else {
    editor = `<select data-rule-line-spec-calculation="${key}">
      <option value="">请选择计算方式</option>
      ${config.calculations.map(([value, label]) =>
        `<option value="${value}" ${selectedOption(value, source.calculation)}>${label}</option>`).join("")}
    </select>`;
  }
  return `
    <div class="rule-value-source" data-rule-line-spec="${key}">
      <select data-rule-line-spec-mode="${key}" aria-label="第 ${index + 1} 行${key}来源方式">
        ${modes.map(([value, label]) =>
          `<option value="${value}" ${selectedOption(value, mode)}>${label}</option>`).join("")}
      </select>
      ${editor}
    </div>
  `;
}

function ruleDimensionEditor(line, index, open = false) {
  const bindings = normalizeDimensionBindings(line);
  const used = new Set(bindings.map((binding) => binding.key));
  const available = AUXILIARY_DIMENSION_CATALOG.filter((item) => !used.has(item.key));
  return `
    <details class="rule-dimension-editor" ${open ? "open" : ""}>
      <summary>
        <span>核算维度</span>
        <small>${escapeHtml(ruleDimensionSummary(line))}</small>
      </summary>
      ${bindings.map((binding) => `
        <div class="rule-dimension-item" data-rule-dimension-binding>
          <div>
            <select data-rule-dimension-key data-current-key="${binding.key}" aria-label="第 ${index + 1} 行辅助核算类型">
              ${AUXILIARY_DIMENSION_CATALOG.map((item) => `
                <option value="${item.key}" ${selectedOption(item.key, binding.key)}>${item.label}</option>
              `).join("")}
            </select>
            <label class="rule-required-check">
              <input type="checkbox" data-rule-dimension-required ${binding.required ? "checked" : ""} />
              必填
            </label>
            <button type="button" class="quiet-button compact" data-remove-rule-dimension="${index}" aria-label="删除${binding.label}辅助核算">删除</button>
          </div>
          ${ruleValueSourceControl(index, `dimension.${binding.key}`, binding.valueSpec, binding.key)}
        </div>
      `).join("")}
      <div class="rule-dimension-add">
        <select data-new-rule-dimension="${index}" ${available.length ? "" : "disabled"}>
          ${available.length
            ? available.map((item) => `<option value="${item.key}">${item.label}</option>`).join("")
            : '<option value="">已配置全部维度</option>'}
        </select>
        <button type="button" class="secondary-button compact" data-add-rule-dimension="${index}" ${available.length ? "" : "disabled"}>添加辅助核算</button>
      </div>
    </details>
  `;
}

function ruleLineConfigEditor(line, index) {
  const field = expandedRuleLineField || "summary";
  const fieldLabel = {
    summary: "摘要",
    account: "科目",
    dimensions: "核算维度",
    currency: "币别",
    exchangeRate: "汇率类型与汇率",
    originalAmount: "原币金额",
    debitAmount: "借方金额",
    creditAmount: "贷方金额",
  }[field] || "分录";
  return `
    <section class="rule-line-config" data-rule-line-config="${index}">
      <div class="rule-line-config-heading">
        <div>
          <strong>第 ${index + 1} 行 · ${fieldLabel}</strong>
          <span>当前只显示这个单元格的设置</span>
        </div>
        <button type="button" class="quiet-button compact-button" data-close-rule-line="${index}">完成</button>
      </div>
      <div class="rule-line-config-grid is-single-field">
        <section class="rule-config-section" ${field === "summary" ? "" : "hidden"}>
          <h3>摘要模板</h3>
          <label class="rule-config-field">
            <input data-rule-line-summary value="${escapeHtml(line.summaryTemplate || "")}" placeholder="例如：员工话费充值 · {供应商/客商}" />
            <details class="rule-summary-token-picker">
              <summary>插入来源字段</summary>
              <div class="rule-summary-tokens">
                ${ruleSummaryTokens.map((token) =>
                  `<button type="button" data-insert-summary-token="${escapeHtml(token)}" title="插入 ${escapeHtml(token)}">{${escapeHtml(token)}}</button>`).join("")}
              </div>
            </details>
          </label>
        </section>
        <section class="rule-config-section" ${field === "account" ? "" : "hidden"}>
          <h3>会计科目</h3>
          <label class="rule-config-field">
            <span>科目来源 *</span>
            <select data-rule-line-account-source>
              <option value="fixed" ${line.accountSource?.mode === "field" ? "" : "selected"}>固定科目</option>
              <option value="field" ${line.accountSource?.mode === "field" ? "selected" : ""}>审批数据处理 · 科目</option>
            </select>
          </label>
          ${line.accountSource?.mode === "field" ? `
            <div class="rule-account-source-readout">
              <strong>审批数据处理 · 科目</strong>
              <small>生成时从对应审批记录的本地补充科目读取，并再次校验有效科目主数据。</small>
              <input type="hidden" data-rule-line-account-field value="debitAccount" />
            </div>
          ` : `
            <div class="rule-config-primary-grid">
              <label class="rule-config-field"><span>科目编码 *</span><input data-rule-line-account-code list="account-code-options" value="${escapeHtml(line.accountCode || "")}" placeholder="选择或输入科目编码" /></label>
              <label class="rule-config-field"><span>科目名称 *</span><input data-rule-line-account-name list="account-name-options" value="${escapeHtml(line.accountName || "")}" placeholder="选择或输入科目名称" /></label>
            </div>
          `}
        </section>
        <section class="rule-config-section" ${field === "dimensions" ? "" : "hidden"}>
          ${ruleDimensionEditor(line, index, field === "dimensions")}
        </section>
        <section class="rule-config-section" ${field === "currency" ? "" : "hidden"}>
          <label class="rule-config-field"><span>币别</span>${ruleValueSourceControl(index, "currency", line.currency, "currency")}</label>
        </section>
        <section class="rule-config-section" ${field === "exchangeRate" ? "" : "hidden"}>
          <h3>汇率类型与汇率</h3>
          <div class="rule-config-value-grid two-fields">
            <label class="rule-config-field"><span>汇率类型</span>${ruleValueSourceControl(index, "exchangeRateType", line.exchangeRateType, "exchangeRateType")}</label>
            <label class="rule-config-field"><span>汇率</span>${ruleValueSourceControl(index, "exchangeRate", line.exchangeRate, "exchangeRate")}</label>
          </div>
        </section>
        <section class="rule-config-section" ${field === "originalAmount" ? "" : "hidden"}>
          <label class="rule-config-field"><span>原币金额</span>${ruleValueSourceControl(index, "originalAmount", line.originalAmount, "originalAmount")}</label>
        </section>
        <section class="rule-config-section" ${field === "debitAmount" ? "" : "hidden"}>
          <label class="rule-config-field"><span>借方金额</span>${ruleValueSourceControl(index, "debitAmount", line.debitAmount, "localAmount")}</label>
        </section>
        <section class="rule-config-section" ${field === "creditAmount" ? "" : "hidden"}>
          <label class="rule-config-field"><span>贷方金额</span>${ruleValueSourceControl(index, "creditAmount", line.creditAmount, "localAmount")}</label>
        </section>
      </div>
    </section>
  `;
}

function ruleEditorContext({ resolveDimensionMasterData = false } = {}) {
  const connector = (state.connectors || []).find((item) =>
    item.id === state.activeFinanceConnectorId)
    || (state.connectors || []).find((item) =>
      item.id === "kingdee-k3cloud" || item.adapter === "kingdee-k3cloud-webapi-v6");
  return {
    masterData: state.masterData || [],
    connectorId: connector?.id || "",
    resolveDimensionMasterData,
    baseCurrency: connector?.currencyCode || "PRE001",
    exchangeRateType: connector?.exchangeRateType || "001",
  };
}

function rulePreviewEvent(draft) {
  return state.events.find((event) =>
    !draft.match?.businessType || event.type === draft.match.businessType) || {
    id: "EV-RULE-PREVIEW",
    company: state.company || "示例公司",
    ledger: state.ledger || "示例账簿",
    date: new Date().toISOString().slice(0, 10),
    type: draft.match?.businessType || "采购付款",
    counterparty: draft.match?.counterparty || "示例供应商",
    amountCents: 70_800,
    amountBreakdown: {
      grossCents: 70_800,
      netCents: 63_185,
      taxCents: 7_615,
      paymentCents: 70_800,
    },
    currency: "CNY",
    exchangeRate: "",
    department: "示例部门",
    project: "示例项目",
    summary: "示例业务",
    exceptionIds: [],
  };
}

function ruleDraftPreview(draft) {
  try {
    const preview = createPurchaseVoucher(
      rulePreviewEvent(draft),
      1,
      {
        ...draft,
        id: draft.id || "RULE-PREVIEW",
        name: draft.name || "当前场景",
        version: draft.version || "预览",
        enabled: true,
      },
      ruleEditorContext(),
    );
    const validation = validateVoucher(preview);
    return `
      <details class="rule-preview-panel ${validation.valid ? "valid" : "invalid"}">
        <summary class="rule-preview-heading">
          <div><strong>样例预览</strong><small>使用一条已识别业务事项；无数据时使用示例值</small></div>
          <span>${validation.valid ? "借贷平衡" : escapeHtml(validation.errors[0])}</span>
        </summary>
        <div class="rule-preview-scroll">
          <table>
            <thead><tr><th>序号</th><th>摘要</th><th>科目</th><th>币别</th><th>汇率</th><th>原币金额</th><th>借方金额</th><th>贷方金额</th></tr></thead>
            <tbody>
              ${preview.lines.map((line) => `
                <tr>
                  <td>${line.lineNo}</td>
                  <td>${escapeHtml(line.summary)}</td>
                  <td>${escapeHtml(line.accountCode)} ${escapeHtml(line.accountName)}</td>
                  <td>${escapeHtml(line.currency || "—")}</td>
                  <td>${escapeHtml(line.exchangeRate || "—")}</td>
                  <td>${Number.isInteger(line.originalAmountCents) ? (line.originalAmountCents / 100).toFixed(2) : "—"}</td>
                  <td>${line.debitCents ? (line.debitCents / 100).toFixed(2) : "—"}</td>
                  <td>${line.creditCents ? (line.creditCents / 100).toFixed(2) : "—"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;
  } catch (error) {
    return `
      <details class="rule-preview-panel invalid">
        <summary class="rule-preview-heading">
          <div><strong>样例预览待完成</strong><small>补齐科目和来源配置后刷新</small></div>
          <span>${escapeHtml(error.message)}</span>
        </summary>
      </details>
    `;
  }
}

function rulesPage() {
  const activeAccounts = (state.masterData || [])
    .filter((item) => item.category === "account" && item.active !== false && item.status !== "停用")
    .sort((left, right) => String(left.code).localeCompare(String(right.code), "zh-CN"));
  const currencies = (state.masterData || [])
    .filter((item) => item.category === "currency" && item.active !== false && item.status !== "停用");
  const editingRule = editingRuleId
    ? state.rules.find((rule) => rule.id === editingRuleId)
    : null;
  if (ruleEditorOpen && !ruleEditorDraft) ruleEditorDraft = ruleDraftFromRule(editingRule);
  const formRule = ruleEditorDraft || ruleDraftFromRule(editingRule);
  if (selectedRuleLineIndex >= formRule.posting.lines.length) {
    selectedRuleLineIndex = Math.max(0, formRule.posting.lines.length - 1);
  }
  return `
    <section class="page-heading">
      <div><span class="eyebrow">确定性优先</span><h1>凭证场景</h1><p>配置适用条件和逐行分录模板；金蝶汇率按币别、业务日期和汇率类型匹配。</p></div>
      <button class="primary-button" data-add-rule>${icon("plus")}${ruleEditorOpen ? "收起编辑器" : "新建场景"}</button>
    </section>
    ${ruleEditorOpen ? `
      <section class="rule-editor rule-entry-editor glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">${editingRule ? `从 v${escapeHtml(editingRule.version)} 创建新版本` : "创建场景版本"}</span><h2>${editingRule ? `修改 ${escapeHtml(editingRule.name)}` : "新建凭证场景"}</h2></div></div>
        <div class="rule-form rule-condition-form">
          <label><span>场景名称 *</span><input data-rule-name value="${escapeHtml(formRule.name)}" placeholder="例如：员工话费充值" /></label>
          <label><span>优先级 *</span><input data-rule-priority type="number" min="1" max="999" value="${formRule.priority}" /></label>
          <label><span>业务类型 *</span><select data-rule-business-type>${["采购付款", "差旅报销", "销售收款", "员工薪酬"].map((value) => `<option value="${value}" ${formRule.match?.businessType === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
          <label><span>限定供应商 / 客商</span><input data-rule-counterparty value="${escapeHtml(formRule.match?.counterparty || "")}" placeholder="留空表示该业务类型全部适用" /></label>
        </div>
        <div class="rule-entry-toolbar">
          <div class="rule-grid-actions">
            <button type="button" data-add-rule-line>新增行</button>
            <button type="button" data-delete-rule-line="${selectedRuleLineIndex}" ${formRule.posting.lines.length <= 2 ? "disabled" : ""}>删除行</button>
            <button type="button" data-insert-rule-line="${selectedRuleLineIndex}">插入行</button>
          </div>
        </div>
        <div class="rule-entry-table-wrap">
          <table class="rule-entry-table" aria-label="凭证分录模板">
            <thead>
              <tr>
                <th>序号</th>
                <th>摘要</th>
                <th>科目编码<span class="required-mark">*</span></th>
                <th>科目全名</th>
                <th>核算维度</th>
                <th>币别<span class="required-mark">*</span></th>
                <th>汇率类型<span class="required-mark">*</span></th>
                <th>原币金额</th>
                <th>单位</th>
                <th>单价</th>
                <th>数量</th>
                <th>借方金额</th>
                <th>贷方金额</th>
                <th>结算方式</th>
                <th>结算号</th>
              </tr>
            </thead>
            <tbody>
              ${formRule.posting.lines.map((line, index) => `
                <tr data-rule-line="${index}" data-select-rule-line="${index}" class="${selectedRuleLineIndex === index ? "is-selected" : ""}">
                  <td class="rule-line-number">${index + 1}</td>
                  <td>
                    <button type="button" class="rule-table-cell-button" data-edit-rule-line="${index}" data-rule-line-field="summary">
                      ${escapeHtml(line.summaryTemplate || "点击设置摘要")}
                    </button>
                  </td>
                  <td>
                    <button type="button" class="rule-table-cell-button ${ruleLineStatus(line) === "待选择科目" ? "needs-attention" : ""}" data-edit-rule-line="${index}" data-rule-line-field="account">
                      ${escapeHtml(ruleAccountCodeDescription(line))}
                    </button>
                  </td>
                  <td><button type="button" class="rule-table-cell-button" data-edit-rule-line="${index}" data-rule-line-field="account">${escapeHtml(ruleAccountNameDescription(line))}</button></td>
                  <td><button type="button" class="rule-table-cell-button" data-edit-rule-line="${index}" data-rule-line-field="dimensions">${escapeHtml(ruleDimensionSummary(line))}</button></td>
                  <td><button type="button" class="rule-table-cell-button" data-edit-rule-line="${index}" data-rule-line-field="currency">${escapeHtml(ruleSpecDescription(line.currency, "currency"))}</button></td>
                  <td>
                    <button type="button" class="rule-table-cell-button rule-rate-readout" data-edit-rule-line="${index}" data-rule-line-field="exchangeRate">
                      <span>${escapeHtml(ruleSpecDescription(line.exchangeRateType, "exchangeRateType"))}</span>
                      <small>${escapeHtml(ruleSpecDescription(line.exchangeRate, "exchangeRate"))}</small>
                    </button>
                  </td>
                  <td><button type="button" class="rule-table-cell-button amount" data-edit-rule-line="${index}" data-rule-line-field="originalAmount">${escapeHtml(ruleSpecDescription(line.originalAmount, "originalAmount"))}</button></td>
                  <td class="rule-empty-cell">—</td>
                  <td class="rule-empty-cell">—</td>
                  <td class="rule-empty-cell">—</td>
                  <td><button type="button" class="rule-table-cell-button amount" data-edit-rule-line="${index}" data-rule-line-field="debitAmount">${escapeHtml(ruleSpecDescription(line.debitAmount, "localAmount"))}</button></td>
                  <td><button type="button" class="rule-table-cell-button amount" data-edit-rule-line="${index}" data-rule-line-field="creditAmount">${escapeHtml(ruleSpecDescription(line.creditAmount, "localAmount"))}</button></td>
                  <td class="rule-empty-cell">—</td>
                  <td class="rule-empty-cell">—</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        ${expandedRuleLineIndex !== null
          ? ruleLineConfigEditor(formRule.posting.lines[expandedRuleLineIndex], expandedRuleLineIndex)
          : ""}
        <datalist id="account-code-options">${activeAccounts.map((account) => `<option value="${escapeHtml(account.code)}">${escapeHtml(account.name)}</option>`).join("")}</datalist>
        <datalist id="account-name-options">${activeAccounts.map((account) => `<option value="${escapeHtml(account.name)}">${escapeHtml(account.code)}</option>`).join("")}</datalist>
        <datalist id="currency-code-options">${currencies.map((currency) => `<option value="${escapeHtml(currency.code)}">${escapeHtml(currency.name)}</option>`).join("")}</datalist>
        ${ruleDraftPreview(formRule)}
        <div class="rule-editor-actions"><button class="quiet-button" data-cancel-rule>取消</button><button class="primary-button" data-save-rule>${icon("check")}${editingRule ? "保存待确认新版本" : "保存为待启用 v1.0"}</button></div>
      </section>
    ` : ""}
    <section class="rules-list">
      ${state.rules.length ? state.rules.map((rule) => `
        <article class="rule-card glass-panel">
          <div class="rule-priority">${rule.priority}</div>
          <div><span class="eyebrow">版本 ${rule.version}${rule.supersededAt ? " · 历史版本" : rule.status === "待启用" ? " · 待启用" : ""}</span><h2>${escapeHtml(rule.name)}</h2><p><strong>条件：</strong>${escapeHtml(rule.condition)}</p><p><strong>动作：</strong>${escapeHtml(rule.action || `${rule.posting?.lines?.length || 2} 行分录`)}</p>${rule.supersedesRuleId ? `<p class="muted-copy">继承自 ${escapeHtml(rule.supersedesRuleId)}</p>` : ""}</div>
          <div class="rule-card-actions">
            ${!rule.supersededAt ? `<button class="text-button" data-edit-rule="${rule.id}">创建新版本</button>` : ""}
            <button class="toggle ${rule.enabled ? "on" : ""}" data-toggle-rule="${rule.id}" aria-label="切换规则" ${rule.supersededAt ? "disabled" : ""}><i></i></button>
          </div>
        </article>
      `).join("") : `
        <article class="glass-panel readonly-workspace">
          <div class="empty-state">${icon("rules")}<h3>尚无凭证场景</h3><p>先按实际业务配置分录、来源字段和金蝶汇率匹配，再用样例数据校验并人工启用。</p></div>
        </article>
      `}
    </section>
  `;
}

function approvalFieldOptions(connector, mappingKey) {
  const fields = connector.approvalFields || [];
  const current = String(connector.fieldMapping?.[mappingKey] || "");
  const hasCurrent = fields.some((field) => String(field.id) === current);
  return `
    <option value="">请选择字段</option>
    ${current && !current.startsWith("source:") && !hasCurrent
      ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（字段已失效）</option>`
      : ""}
    ${fields.length ? `
      <optgroup label="飞书审批字段">
        ${fields.map((field) => `
          <option value="${escapeHtml(field.id)}" ${String(field.id) === current ? "selected" : ""}>
            ${escapeHtml(field.name)}${field.required ? " *" : ""} · ${escapeHtml(field.id)}
          </option>
        `).join("")}
      </optgroup>
    ` : ""}
  `;
}

function approvalAdditionalFields(connector) {
  const selectedIds = new Set(
    (connector.additionalApprovalFieldIds || []).map((fieldId) => String(fieldId)),
  );
  return (connector.approvalFields || [])
    .filter((field) => selectedIds.has(String(field.id)));
}

function approvalAdditionalFieldCandidates(connector) {
  const selectedIds = new Set(
    (connector.additionalApprovalFieldIds || []).map((fieldId) => String(fieldId)),
  );
  const mappedFieldIds = new Set(
    Object.values(connector.fieldMapping || {})
      .map((fieldId) => String(fieldId))
      .filter((fieldId) => fieldId && !fieldId.startsWith("source:")),
  );
  return (connector.approvalFields || [])
    .filter((field) =>
      !selectedIds.has(String(field.id))
      && !mappedFieldIds.has(String(field.id)));
}

function localDateInputValue(dayOffset = 0) {
  const value = new Date();
  value.setDate(value.getDate() + dayOffset);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createApprovalDataCustomFilter() {
  return {
    id: `approval-filter-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    field: "approvalName",
    operator: "contains",
    value: "",
  };
}

function selectedApprovalFilterFields() {
  const connector = (state.connectors || []).find((item) =>
    item.id === selectedApprovalConnectorId
    && item.adapter === "feishu-approval-v4");
  const profileId = selectedApprovalProfileId === "__new__"
    ? ""
    : selectedApprovalProfileId;
  return approvalProcessingFieldsForConnector(connector, profileId);
}

function approvalRecordSearchValues(event) {
  const approvalValues = (event.approvalFieldValues || [])
    .flatMap((field) => Array.isArray(field.value) ? field.value.flat(Infinity) : [field.value])
    .map((value) => typeof value === "object" ? JSON.stringify(value) : value);
  return [
    event.reference,
    event.counterparty,
    event.department,
    event.project,
    event.summary,
    event.approvalName,
    ...approvalValues,
  ];
}

function approvalCustomFilterValueControl(condition, fields) {
  const field = approvalProcessingField(condition.field, fields);
  if (["isEmpty", "isNotEmpty"].includes(condition.operator)) {
    return `<span class="approval-custom-filter-no-value">无需填写值</span>`;
  }
  if (field.type === "status") {
    return `
      <select data-approval-custom-value aria-label="${escapeHtml(field.label)}的筛选值">
        <option value="approved" ${condition.value === "approved" ? "selected" : ""}>已通过</option>
        <option value="pending" ${condition.value === "pending" ? "selected" : ""}>审批中</option>
        <option value="rejected" ${condition.value === "rejected" ? "selected" : ""}>已拒绝</option>
      </select>
    `;
  }
  const type = field.type === "date" ? "date" : field.type === "money" ? "number" : "text";
  const placeholder = field.type === "money" ? "按元填写，例如 1000.00" : `请输入${field.label}`;
  return `
    <input
      type="${type}"
      ${field.type === "money" ? 'step="0.01"' : ""}
      value="${escapeHtml(condition.value || "")}"
      placeholder="${escapeHtml(placeholder)}"
      aria-label="${escapeHtml(field.label)}的筛选值"
      data-approval-custom-value
    />
  `;
}

function approvalDataCustomFilterRows(fields) {
  const standardFields = fields.filter((field) => !field.approvalFieldId);
  const templateFields = fields.filter((field) => field.approvalFieldId);
  const fieldOptions = (items, conditionField) => items.map((field) => `
    <option value="${escapeHtml(field.key)}" ${field.key === conditionField ? "selected" : ""}>
      ${escapeHtml(field.label)}
    </option>
  `).join("");
  return approvalDataCustomFilterDrafts.map((condition, index) => {
    const operators = approvalProcessingOperators(condition.field, fields);
    const options = fieldOptions(standardFields, condition.field);
    const approvalOptions = fieldOptions(templateFields, condition.field);
    return `
      <div class="approval-custom-filter-row" data-approval-custom-filter="${escapeHtml(condition.id)}">
        <span class="approval-custom-filter-join">${index === 0 ? "条件" : "并且"}</span>
        <select data-approval-custom-field aria-label="筛选字段">
          <optgroup label="标准字段">${options}</optgroup>
          ${templateFields.length
            ? `<optgroup label="审批模板全部字段">${approvalOptions}</optgroup>`
            : ""}
        </select>
        <select data-approval-custom-operator aria-label="筛选运算符">
          ${operators.map((operator) => `
            <option value="${escapeHtml(operator.key)}" ${operator.key === condition.operator ? "selected" : ""}>
              ${escapeHtml(operator.label)}
            </option>
          `).join("")}
        </select>
        <div class="approval-custom-filter-value">
          ${approvalCustomFilterValueControl(condition, fields)}
        </div>
        <button
          class="icon-button"
          type="button"
          data-remove-approval-custom-filter="${escapeHtml(condition.id)}"
          aria-label="删除筛选条件 ${index + 1}"
        >×</button>
      </div>
    `;
  }).join("");
}

function approvalFieldPreview(value, maxLength = 52) {
  const normalized = approvalFieldDisplayValue(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function approvalCounterpartyFieldOptions(record) {
  const selectedId = String(record.counterpartyFieldSelection?.fieldId || "");
  return approvalRecordFieldEntries(record).map((field) => `
    <option
      value="${escapeHtml(field.id)}"
      ${field.id === selectedId ? "selected" : ""}
      ${field.displayValue ? "" : "disabled"}
    >
      ${escapeHtml(field.name)} · ${escapeHtml(approvalFieldPreview(field.value) || "未填写")}
    </option>
  `).join("");
}

function approvalCounterpartyEditorRow(record) {
  const selectedField = approvalRecordFieldEntries(record)
    .find((field) => field.id === String(record.counterpartyFieldSelection?.fieldId || ""));
  return `
    <tr class="approval-counterparty-editor-row" data-approval-counterparty-editor="${escapeHtml(record.id)}">
      <td colspan="9">
        <form class="approval-counterparty-editor" data-approval-counterparty-form="${escapeHtml(record.id)}">
          <div class="approval-counterparty-editor-copy">
            <strong>更换供应商 / 客商</strong>
            <span>仅修改当前审批记录 ${escapeHtml(record.approvalNo || record.reference || record.externalId || record.id)}</span>
          </div>
          <label>
            <span>使用当前审批中的字段</span>
            <select name="approvalFieldId" data-approval-counterparty-field required>
              <option value="">请选择非空审批字段</option>
              ${approvalCounterpartyFieldOptions(record)}
            </select>
          </label>
          <div class="approval-counterparty-preview">
            <span>替换后</span>
            <strong data-approval-counterparty-preview>
              ${escapeHtml(selectedField?.displayValue || "请选择字段")}
            </strong>
          </div>
          <div class="approval-counterparty-editor-actions">
            <button class="quiet-button" type="button" data-cancel-approval-counterparty>取消</button>
            <button class="primary-button" type="submit">${icon("check")}保存本条记录</button>
          </div>
        </form>
      </td>
    </tr>
  `;
}

function approvalRecordDetailModal(record, connector) {
  if (!record) return "";
  const approvalNo = record.approvalNo || record.reference || record.externalId || record.id;
  const approvalFields = approvalRecordFieldEntries(record);
  const summaryFields = [
    ["审批模板", record.approvalName || connector?.approvalName],
    ["审批状态", record.approvalStatus === "approved" ? "已通过" : "审批中"],
    ["完成日期", approvalCompletionDate(record)],
    ["业务日期", record.date],
    ["金额", formatMoney(Number(record.amountCents || 0))],
    ["供应商 / 客商", record.counterparty],
    ["部门 / 项目", [record.department, record.project].filter(Boolean).join(" / ")],
  ];
  return `
    <div class="approval-detail-layer" data-approval-detail-layer>
      <section
        class="approval-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-detail-title"
      >
        <header class="approval-detail-header">
          <div>
            <span>完整审批数据</span>
            <h2 id="approval-detail-title">${escapeHtml(approvalNo)}</h2>
            <p>${escapeHtml(record.summary || "审批详情")}</p>
          </div>
          <button
            class="icon-button approval-detail-close"
            type="button"
            data-close-approval-detail
            aria-label="关闭审批详情"
          >${icon("close")}</button>
        </header>
        <div class="approval-detail-scroll">
          <article class="approval-detail-document" aria-label="审批打印式详情">
            <header>
              <div>
                <span>审批单</span>
                <h3>${escapeHtml(record.approvalName || connector?.approvalName || "审批记录")}</h3>
              </div>
              <strong>${escapeHtml(approvalNo)}</strong>
            </header>
            <dl class="approval-detail-summary">
              ${summaryFields.map(([label, value]) => `
                <div>
                  <dt>${escapeHtml(label)}</dt>
                  <dd>${escapeHtml(value || "未填写")}</dd>
                </div>
              `).join("")}
            </dl>
            <section class="approval-detail-fields">
              <div class="approval-detail-section-heading">
                <h4>审批字段明细</h4>
                <span>${approvalFields.length} 个字段</span>
              </div>
              <dl>
                ${approvalFields.map((field) => `
                  <div data-approval-detail-field="${escapeHtml(field.id)}">
                    <dt>${escapeHtml(field.name)}</dt>
                    <dd class="${field.displayValue ? "" : "empty"}">
                      ${escapeHtml(field.displayValue || "未填写")}
                    </dd>
                  </div>
                `).join("")}
              </dl>
            </section>
            ${record.counterpartyFieldSelection ? `
              <footer>
                当前“供应商 / 客商”取自审批字段：
                ${escapeHtml(record.counterpartyFieldSelection.fieldName || record.counterpartyFieldSelection.fieldId)}
              </footer>
            ` : ""}
          </article>
        </div>
      </section>
    </div>
  `;
}

function approvalDataPage() {
  const connectors = (state.connectors || []).filter((item) =>
    item.adapter === "feishu-approval-v4");
  if (!connectors.length) {
    return `
      <section class="page-heading compact">
        <div><h1>审批数据</h1><p>筛选飞书审批数据，并将审批字段提取为可生成凭证的业务字段。</p></div>
        <button class="primary-button" data-route="plan">添加飞书连接器</button>
      </section>
      ${readonlyWorkspaceEmpty("尚未配置飞书 / Lark 审批连接器")}
    `;
  }
  if (!connectors.some((item) => item.id === selectedApprovalConnectorId)) {
    selectedApprovalConnectorId = connectors[0].id;
  }
  const connector = connectors.find((item) => item.id === selectedApprovalConnectorId);
  const approvalProfiles = approvalProfilesForConnector(connector);
  if (
    selectedApprovalProfileId !== "__new__"
    && !approvalProfiles.some((profile) =>
      String(profile.id || "") === String(selectedApprovalProfileId || ""))
  ) {
    selectedApprovalProfileId = String(approvalProfiles[0]?.id || "");
  }
  const approvalProfile = selectedApprovalProfileId === "__new__"
    ? {
      id: "",
      approvalCode: "",
      approvalName: "",
      approvalFields: [],
      fieldMapping: {},
      fieldSources: [],
      additionalApprovalFieldIds: [],
      syncCursor: {},
    }
    : approvalProfileForConnector(connector, selectedApprovalProfileId)
      || approvalProfiles[0]
      || {
        id: "",
        approvalCode: "",
        approvalName: "",
        approvalFields: [],
        fieldMapping: {},
        fieldSources: [],
        additionalApprovalFieldIds: [],
        syncCursor: {},
      };
  const fields = approvalProfile.approvalFields || [];
  const approvalFilterFields = approvalProcessingFieldsForConnector(
    connector,
    approvalProfile.id || "",
  );
  const mapping = approvalProfile.fieldMapping || {};
  const additionalFields = approvalAdditionalFields(approvalProfile);
  const additionalFieldCandidates = approvalAdditionalFieldCandidates(approvalProfile);
  const queryDateFrom = connector.queryDateFrom || localDateInputValue(-7);
  const queryDateTo = connector.queryDateTo || localDateInputValue();
  const today = localDateInputValue();
  const dateFieldCandidates = fields.filter((field) =>
    String(field.type || "").toLowerCase().includes("date")
    || /(日期|所属期|时间)/.test(String(field.name || "")));
  const syncReady = connector.status === "connected"
    && approvalProfiles.length > 0
    && String(connector.queryDateFrom || "").trim()
    && String(connector.queryDateTo || "").trim()
    && approvalProfiles.every((profile) =>
      String(profile.approvalCode || "").trim()
      && profile.fieldMapping?.date
      && profile.fieldMapping?.counterparty
      && profile.fieldMapping?.amount);
  const keyword = approvalDataFilters.keyword.trim().toLocaleLowerCase("zh-CN");
  state.approvalProcessingConfirmations ||= {};
  const selectedApprovalCode = String(approvalProfile.approvalCode || "").trim();
  const connectorRecords = filterApprovalRecordsByCompletionDate(
    filterApprovalRecordsByProfile(
      (state.events || []).filter((event) => event.sourceSystem === "feishu"),
      selectedApprovalCode,
    ),
    connector.queryDateFrom,
    connector.queryDateTo,
  );
  const detailRecord = connectorRecords.find((event) =>
    event.id === selectedApprovalDetailId) || null;
  if (selectedApprovalDetailId && !detailRecord) selectedApprovalDetailId = null;
  if (
    editingApprovalCounterpartyId
    && !connectorRecords.some((event) => event.id === editingApprovalCounterpartyId)
  ) editingApprovalCounterpartyId = null;
  const searchedRecords = connectorRecords
    .filter((event) => !keyword || approvalRecordSearchValues(event)
      .some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(keyword)));
  const records = approvalDataCustomFilters.length
    ? searchedRecords.filter((event) =>
      approvalDataCustomFilters.every((condition) =>
        approvalRecordMatchesCondition({
          ...event,
          approvalName: event.approvalName || connector.approvalName || "",
        }, condition, approvalFilterFields)))
    : searchedRecords;
  const visibleRecords = records.slice(0, APPROVAL_DATA_RENDER_LIMIT);
  const selectedVisibleCount = visibleRecords
    .filter((event) => selectedApprovalRecordIds.has(event.id)).length;
  const allVisibleSelected = visibleRecords.length > 0
    && selectedVisibleCount === visibleRecords.length;
  const confirmedRecordIds = new Set(
    Object.keys(state.approvalProcessingConfirmations),
  );
  const confirmedRecordCount = connectorRecords
    .filter((event) => confirmedRecordIds.has(event.id)).length;
  [...selectedApprovalRecordIds].forEach((recordId) => {
    if (!connectorRecords.some((event) => event.id === recordId)) {
      selectedApprovalRecordIds.delete(recordId);
    }
  });
  const selectedConfirmedCount = [...selectedApprovalRecordIds]
    .filter((recordId) => confirmedRecordIds.has(recordId)).length;
  const appliedFilterCount = approvalDataCustomFilters.length;
  const statusText = connector.status === "connected" ? "连接可用" : "请先完成连接测试";
  const approvalPanels = [
    ["query", "查询范围"],
    ["mapping", "字段映射"],
    ["records", "审批记录"],
  ];
  if (!approvalPanels.some(([panelId]) => panelId === approvalWorkspacePanel)) {
    approvalWorkspacePanel = "query";
  }
  return `
    <section class="approval-data-topbar" data-approval-layer="header">
      <div class="approval-data-heading-row">
        <button class="workflow-return-button approval-return-button" data-route="dashboard">${icon("arrow")}返回流程工作区</button>
        <div class="approval-data-title">
          <h1>审批数据</h1>
        </div>
        <button class="primary-button approval-sync-button" data-sync-approvals="${connector.id}" ${syncReady ? "" : "disabled"}>${icon("refresh")}同步审批数据</button>
      </div>
      <nav class="approval-subcards" role="tablist" aria-label="审批数据页面">
        ${approvalPanels.map(([panelId, label]) => `
          <button
            class="approval-subcard ${approvalWorkspacePanel === panelId ? "active" : ""}"
            type="button"
            role="tab"
            aria-selected="${approvalWorkspacePanel === panelId}"
            aria-controls="approval-page-${panelId}"
            data-approval-panel="${panelId}"
          >
            <span>${label}</span>
            ${panelId === "records" ? `<small>${records.length}</small>` : ""}
          </button>
        `).join("")}
      </nav>
    </section>
    ${connectorJob ? `<div class="job-progress"><div><strong>审批同步任务</strong><span>${connectorJob.status}</span></div><progress max="100" value="${connectorJob.progress?.percent || 20}"></progress></div>` : ""}
    <form class="approval-config-form" data-approval-config-form="${connector.id}">
      <input type="hidden" name="profileId" value="${escapeHtml(approvalProfile.id || "")}" />
      <section
        class="approval-page-panel glass-panel approval-query-section"
        id="approval-page-query"
        role="tabpanel"
        data-approval-page="query"
        ${approvalWorkspacePanel === "query" ? "" : "hidden"}
      >
        <header class="approval-page-header">
          <h2>审批模板与查询范围</h2>
          <div class="approval-page-actions">
            <button class="secondary-button" type="button" data-add-approval-profile>${icon("plus")}新增 approval_code</button>
            <button class="secondary-button" type="button" data-read-feishu-fields="${connector.id}">${icon("refresh")}读取审批字段</button>
          </div>
        </header>
        <div class="approval-page-body">
          <div class="approval-source-bar">
            <label>
              <span>数据来源</span>
              <select data-select-approval-connector>
                ${connectors.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === connector.id ? "selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.environment)}</option>`).join("")}
              </select>
            </label>
            <div class="approval-source-status">
              <span class="connector-state ${connector.status === "connected" ? "success" : "pending"}"><i></i>${statusText}</span>
              <small>连接凭据在“连接器”页面维护</small>
            </div>
          </div>
          <div class="approval-query-fields">
            <label class="approval-profile-field">
              <span>已配置审批模板</span>
              <select data-select-approval-profile>
                ${approvalProfiles.map((profile) => `
                  <option
                    value="${escapeHtml(profile.id)}"
                    ${String(profile.id || "") === String(approvalProfile.id || "") ? "selected" : ""}
                  >${escapeHtml(profile.approvalName || profile.approvalCode)} · ${escapeHtml(profile.approvalCode)}</option>
                `).join("")}
                ${selectedApprovalProfileId === "__new__"
                  ? `<option value="__new__" selected>新增审批模板</option>`
                  : ""}
              </select>
            </label>
            <label class="approval-code-field">
              <span>审批模板编码（approval_code）</span>
              <input name="approvalCode" value="${escapeHtml(approvalProfile.approvalCode || "")}" autocomplete="off" placeholder="请输入飞书审批模板编码" required />
            </label>
            <div class="approval-query-date-range">
              <label>
                <span>审批记录完成日期起</span>
                <input type="date" name="queryDateFrom" value="${escapeHtml(queryDateFrom)}" max="${escapeHtml(today)}" required />
              </label>
              <span class="approval-date-separator">至</span>
              <label>
                <span>审批记录完成日期止</span>
                <input type="date" name="queryDateTo" value="${escapeHtml(queryDateTo)}" max="${escapeHtml(today)}" required />
              </label>
            </div>
          </div>
          ${fields.length ? `
            <details class="approval-fields-readback">
              <summary>
                <span><strong>${escapeHtml(approvalProfile.approvalName || "已读取审批模板")}</strong><small>${fields.length} 个字段 · ${escapeHtml(approvalProfile.lastApprovalFieldsReadAt || "刚刚读取")}</small></span>
                <span>字段清单</span>
              </summary>
              <div>${fields.map((field) => `<span>${escapeHtml(field.name)} <code>${escapeHtml(field.id)}</code></span>`).join("")}</div>
            </details>
          ` : `<p class="connector-empty-hint">填写模板编码后读取字段。</p>`}
        </div>
      </section>
      <section
        class="approval-page-panel glass-panel approval-mapping-section"
        id="approval-page-mapping"
        role="tabpanel"
        data-approval-page="mapping"
        ${approvalWorkspacePanel === "mapping" ? "" : "hidden"}
      >
        <header class="approval-page-header">
          <h2>字段映射</h2>
          <div class="approval-page-actions">
            <button
              class="secondary-button"
              type="button"
              aria-expanded="false"
              data-open-approval-additional-field
              ${additionalFieldCandidates.length ? "" : "disabled"}
              title="${additionalFieldCandidates.length ? "添加当前审批模板中的其他字段" : "没有可添加的其他审批字段"}"
            >${icon("plus")}添加其他字段</button>
            <button class="primary-button" type="button" data-save-approval-config="${connector.id}">${icon("check")}保存查询与映射</button>
          </div>
        </header>
        <div class="approval-page-body">
          <div class="approval-additional-field-editor" data-approval-additional-field-editor hidden>
              <label>
                <span>审批字段</span>
                <select data-approval-additional-field>
                  <option value="">请选择审批字段</option>
                  ${additionalFieldCandidates.map((field) => `
                    <option value="${escapeHtml(field.id)}">
                      ${escapeHtml(field.name)}${field.required ? " *" : ""} · ${escapeHtml(field.id)}
                    </option>
                  `).join("")}
                </select>
              </label>
              <p>仅显示当前审批模板中尚未映射的字段。</p>
              <button class="primary-button" type="button" data-add-approval-additional-field="${connector.id}">添加字段</button>
              <button class="quiet-button" type="button" data-cancel-approval-additional-field>取消</button>
          </div>
          ${additionalFields.length ? `
            <div class="approval-additional-field-list" aria-label="已添加的其他审批字段">
              <span class="approval-additional-field-list-label">其他字段</span>
              ${additionalFields.map((field) => `
                <span class="approval-additional-field-pill">
                  ${escapeHtml(field.name)} · ${escapeHtml(field.id)}
                  <button
                    type="button"
                    aria-label="移除 ${escapeHtml(field.name)}"
                    data-remove-approval-additional-field="${escapeHtml(field.id)}"
                    data-approval-additional-connector="${connector.id}"
                  >×</button>
                </span>
              `).join("")}
              <small>同步时随审批记录保留</small>
            </div>
          ` : ""}
          <div class="approval-mapping-grid">
            ${approvalMappingFields.map(([key, label, hint]) => `
              <label>
                <span>
                  <strong>${label}</strong>
                  <small>${hint}</small>
                  ${key === "date" && dateFieldCandidates.length ? `
                    <em>建议：${dateFieldCandidates.map((field) => escapeHtml(field.name)).join("、")}</em>
                  ` : ""}
                </span>
                <select data-feishu-mapping="${key}" ${["date", "counterparty", "amount"].includes(key) ? "required" : ""}>${approvalFieldOptions(approvalProfile, key)}</select>
              </label>
            `).join("")}
          </div>
        </div>
      </section>
    </form>
    <section
      class="approval-records-workspace"
      id="approval-page-records"
      role="tabpanel"
      data-approval-page="records"
      ${approvalWorkspacePanel === "records" ? "" : "hidden"}
    >
      <div class="approval-records-controls" data-approval-layer="controls">
        ${selectedApprovalRecordIds.size ? `
          <div class="approval-records-commandbar approval-bulk-commandbar">
            <div class="approval-records-summary">
              <strong>已选 ${selectedApprovalRecordIds.size} 条</strong>
              <span>确认后才会进入审批数据处理</span>
            </div>
            <div class="approval-selection-actions" aria-label="审批记录传递操作">
              <button class="quiet-button" type="button" data-clear-approval-selection>取消选择</button>
              ${selectedConfirmedCount ? `
                <button class="quiet-button" type="button" data-revoke-approval-selection>撤回所选传递</button>
              ` : ""}
              <button class="primary-button" type="button" data-confirm-approval-selection>
                ${icon("check")}确认并传递
              </button>
            </div>
          </div>
        ` : `
          <form class="approval-records-filter-form" data-approval-filter-form>
            <div class="approval-records-commandbar">
              <div class="approval-records-summary">
                <strong>${records.length}</strong>
                <span>条审批记录</span>
                ${confirmedRecordCount ? `<span class="approval-confirmed-count">${confirmedRecordCount} 条已确认</span>` : ""}
              </div>
              <div class="approval-records-tools">
                <label class="approval-toolbar-search">
                  <span>${icon("search")}关键词</span>
                  <input
                    name="keyword"
                    value="${escapeHtml(approvalDataFilters.keyword)}"
                    placeholder="搜索审批单号、标准字段或全部审批字段"
                    autocomplete="off"
                  />
                </label>
                <button class="icon-button approval-toolbar-search-submit" type="submit" aria-label="搜索审批记录">${icon("search")}</button>
                <button
                  class="secondary-button approval-filter-toggle ${approvalFiltersExpanded ? "active" : ""}"
                  type="button"
                  aria-expanded="${approvalFiltersExpanded}"
                  aria-controls="approval-custom-filters"
                  data-toggle-approval-filters
                >
                  筛选
                  ${appliedFilterCount ? `<small>${appliedFilterCount}</small>` : ""}
                </button>
                ${confirmedRecordCount ? `
                  <button class="quiet-button approval-processing-entry" type="button" data-route="approvalProcessing">进入数据处理</button>
                ` : ""}
              </div>
            </div>
          </form>
          <form
            class="approval-custom-filters"
            id="approval-custom-filters"
            data-approval-custom-filter-form
            ${approvalFiltersExpanded ? "" : "hidden"}
          >
            <header>
              <div>
                <strong>自定义多字段条件</strong>
                <span>多个条件按“并且（AND）”组合${approvalDataCustomFilters.length ? ` · 已应用 ${approvalDataCustomFilters.length} 个` : ""}</span>
              </div>
              <div>
                ${approvalDataCustomFilterDrafts.length ? `
                  <button class="quiet-button" type="button" data-clear-approval-custom-filters>清空条件</button>
                ` : ""}
                <button class="secondary-button" type="button" data-add-approval-custom-filter>${icon("plus")}添加条件</button>
                ${approvalDataCustomFilterDrafts.length ? `
                  <button class="primary-button" type="submit">${icon("search")}应用条件</button>
                ` : ""}
              </div>
            </header>
            ${approvalDataCustomFilterDrafts.length
              ? `<div class="approval-custom-filter-list">${approvalDataCustomFilterRows(approvalFilterFields)}</div>`
              : ""}
          </form>
        `}
      </div>
      <div class="approval-table-layer" data-approval-layer="table">
        <div class="approval-table-wrap">
          <table class="approval-data-table" aria-label="已提取审批数据">
            <thead><tr>
              <th class="approval-selection-cell">
                <input
                  type="checkbox"
                  data-select-visible-approvals
                  aria-label="选择当前显示的全部审批记录"
                  ${allVisibleSelected ? "checked" : ""}
                  ${visibleRecords.length ? "" : "disabled"}
                />
              </th>
              <th>业务日期</th><th>审批单号</th><th>审批模板</th><th>供应商 / 客商</th><th>金额</th><th>部门 / 项目</th><th>审批状态</th><th>传递状态</th>
            </tr></thead>
            <tbody>
              ${visibleRecords.length ? visibleRecords.map((event) => `
                <tr class="${confirmedRecordIds.has(event.id) ? "confirmed-for-processing" : ""}" data-approval-record-row="${escapeHtml(event.id)}">
                  <td class="approval-selection-cell">
                    <input
                      type="checkbox"
                      data-select-approval-record="${escapeHtml(event.id)}"
                      aria-label="选择审批记录 ${escapeHtml(event.reference || event.externalId || event.id)}"
                      ${selectedApprovalRecordIds.has(event.id) ? "checked" : ""}
                    />
                  </td>
                  <td>${escapeHtml(event.date || "-")}</td>
                  <td>
                    <button
                      class="approval-record-number"
                      type="button"
                      data-open-approval-detail="${escapeHtml(event.id)}"
                      aria-label="查看审批单 ${escapeHtml(event.approvalNo || event.reference || event.externalId || event.id)} 的完整数据"
                    >
                      <strong>${escapeHtml(event.approvalNo || event.reference || event.externalId || "-")}</strong>
                    </button>
                    <small>${escapeHtml(event.summary || "")}</small>
                  </td>
                  <td>${escapeHtml(event.approvalName || connector.approvalName || "-")}</td>
                  <td class="approval-counterparty-cell">
                    <button
                      class="approval-counterparty-button"
                      type="button"
                      data-edit-approval-counterparty="${escapeHtml(event.id)}"
                      aria-expanded="${editingApprovalCounterpartyId === event.id}"
                      aria-label="修改审批单 ${escapeHtml(event.approvalNo || event.reference || event.externalId || event.id)} 的供应商或客商"
                    >
                      <span>${escapeHtml(event.counterparty || "-")}</span>
                      <small>
                        ${event.counterpartyFieldSelection
                          ? `来自：${escapeHtml(event.counterpartyFieldSelection.fieldName || event.counterpartyFieldSelection.fieldId)}`
                          : "点击更换来源字段"}
                      </small>
                    </button>
                  </td>
                  <td>${formatMoney(Number(event.amountCents || 0))}</td>
                  <td>${escapeHtml([event.department, event.project].filter(Boolean).join(" / ") || "-")}</td>
                  <td><span class="status-pill ${event.approvalStatus === "approved" ? "success" : "pending"}">${event.approvalStatus === "approved" ? "已通过" : "审批中"}</span></td>
                  <td>
                    <span class="status-pill ${confirmedRecordIds.has(event.id) ? "success" : "neutral"}">
                      ${confirmedRecordIds.has(event.id) ? "已确认" : "未传递"}
                    </span>
                  </td>
                </tr>
                ${editingApprovalCounterpartyId === event.id
                  ? approvalCounterpartyEditorRow(event)
                  : ""}
              `).join("") : `<tr><td colspan="9"><div class="empty-state">${icon("briefcase")}<p>当前筛选条件下没有已提取的审批数据。</p></div></td></tr>`}
            </tbody>
          </table>
        </div>
        ${records.length > APPROVAL_DATA_RENDER_LIMIT ? `<p class="approval-result-limit">仅显示前 ${APPROVAL_DATA_RENDER_LIMIT} 条，请继续缩小筛选范围。</p>` : ""}
      </div>
    </section>
    ${approvalRecordDetailModal(detailRecord, connector)}
  `;
}

function approvalProcessingAccountOptions(accounts, selectedId) {
  const preferred = accounts.filter((account) =>
    account.group === "成本类"
    || account.normalBalance === "借" && /^(4|54|56|57|58)/.test(String(account.code || "")));
  const preferredIds = new Set(preferred.map((account) => account.id));
  const other = accounts.filter((account) => !preferredIds.has(account.id));
  const options = (items) => items.map((account) => `
    <option value="${escapeHtml(account.id)}" ${account.id === selectedId ? "selected" : ""}>
      ${escapeHtml(account.code)} ${escapeHtml(account.name)}
    </option>
  `).join("");
  return `
    <option value="">请选择科目</option>
    ${preferred.length ? `<optgroup label="建议：成本费用科目">${options(preferred)}</optgroup>` : ""}
    ${other.length ? `<optgroup label="其他有效科目">${options(other)}</optgroup>` : ""}
  `;
}

function approvalBankUnionRows() {
  return buildApprovalBankUnion(
    approvalRecordsForProcessing(
      state.events || [],
      state.approvalProcessingConfirmations || {},
    ),
  );
}

function voucherForUnionRow(row) {
  return (state.vouchers || []).find((voucher) =>
    row.sourceEventIds.length
    && row.sourceEventIds.some((eventId) => voucher.sourceEventIds.includes(eventId)));
}

function unionStatusDetails(status) {
  return {
    matched: { label: "匹配且金额一致", tone: "success" },
    amount_mismatch: { label: "金额不一致", tone: "warning" },
    bank_only: { label: "仅银行流水", tone: "pending" },
    approval_only: { label: "仅审批记录", tone: "pending" },
  }[status] || { label: "待处理", tone: "neutral" };
}

function unionBankSerial(event) {
  return event?.bankSerial
    || (event?.sourceRecords || [])
      .map((record) => record?.referenceFields?.bankSerial)
      .find(Boolean)
    || "—";
}

function validApprovalAccount(event) {
  if (!event?.debitAccountMasterDataId) return null;
  return (state.masterData || []).find((item) =>
    item.id === event.debitAccountMasterDataId
    && item.category === "account"
    && item.active !== false
    && item.status !== "停用") || null;
}

function unionRuleOptions(selectedRuleId) {
  const rules = (state.rules || [])
    .filter((rule) => rule.enabled && postingRuleComplete(rule))
    .sort((left, right) => (right.priority || 0) - (left.priority || 0));
  return `
    <option value="">请选择凭证场景</option>
    ${rules.map((rule) => `
      <option value="${escapeHtml(rule.id)}" ${rule.id === selectedRuleId ? "selected" : ""}>
        ${escapeHtml(rule.name)} · v${escapeHtml(rule.version)}
      </option>
    `).join("")}
  `;
}

function autoRuleForUnionRow(row) {
  if (row.status !== "matched" || !validApprovalAccount(row.approvalEvent)) return null;
  const event = buildUnionVoucherEvent(row);
  return matchingPostingRules(state.rules || [], event)[0] || null;
}

function approvalProcessingPage() {
  state.approvalUnionSelections ||= {};
  state.approvalProcessingConfirmations ||= {};
  const rows = approvalBankUnionRows();
  const approvalRecords = (state.events || []).filter(isApprovalRecord);
  const detailRecord = approvalRecords.find((record) =>
    record.id === selectedApprovalDetailId) || null;
  if (selectedApprovalDetailId && !detailRecord) selectedApprovalDetailId = null;
  const detailConnector = detailRecord
    ? (state.connectors || []).find((connector) =>
      connector.adapter === "feishu-approval-v4"
      && (
        !detailRecord.approvalCode
        || approvalProfilesForConnector(connector).some((profile) =>
          profile.approvalCode === detailRecord.approvalCode)
      )) || null
    : null;
  const confirmedApprovalCount = approvalRecords
    .filter((record) => Object.hasOwn(state.approvalProcessingConfirmations, record.id)).length;
  const accounts = (state.masterData || [])
    .filter((item) => item.category === "account" && item.active !== false && item.status !== "停用")
    .sort((left, right) => String(left.code || "").localeCompare(String(right.code || ""), "zh-CN"));
  const counts = rows.reduce((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1;
    return result;
  }, {});
  const automaticRows = rows.filter((row) =>
    !voucherForUnionRow(row) && autoRuleForUnionRow(row));

  return `
    <section class="page-heading compact approval-processing-heading">
      <div>
        <span class="eyebrow">银行与审批全量对照</span>
        <h1>审批数据处理</h1>
        <p>左侧保留银行数据，右侧只接收在“审批记录”中人工确认的审批数据；科目和凭证场景仅作为本地处理字段保存。</p>
      </div>
      <div class="heading-actions">
        <button class="secondary-button" data-route="approvals">${icon("briefcase")}查看审批原始数据</button>
        <button class="primary-button" data-auto-generate-union ${automaticRows.length ? "" : "disabled"}>
          ${icon("voucher")}自动生成 ${automaticRows.length} 张草稿
        </button>
      </div>
    </section>
    <section class="approval-processing-gate ${confirmedApprovalCount ? "ready" : "warning"}" aria-label="审批记录确认状态">
      <div>
        ${icon(confirmedApprovalCount ? "check" : "alert")}
        <span>
          <strong>已确认 ${confirmedApprovalCount} / ${approvalRecords.length} 条审批记录</strong>
          <small>${confirmedApprovalCount ? "本页不会读取尚未确认的审批记录。" : "尚未确认任何审批记录，审批侧数据不会进入本页。"}</small>
        </span>
      </div>
      <button class="secondary-button" data-route="approvals">返回审批记录筛选</button>
    </section>
    <section class="approval-union-summary" aria-label="联合数据统计">
      <article><span>联合数据</span><strong>${rows.length}</strong></article>
      <article class="success"><span>匹配且金额一致</span><strong>${counts.matched || 0}</strong></article>
      <article><span>仅银行流水</span><strong>${counts.bank_only || 0}</strong></article>
      <article><span>仅审批记录</span><strong>${counts.approval_only || 0}</strong></article>
      <article class="warning"><span>金额不一致</span><strong>${counts.amount_mismatch || 0}</strong></article>
    </section>
    <section class="approval-union-panel glass-panel">
      <header class="approval-union-toolbar">
        <div>
          <strong>银行流水 ∪ 已确认审批记录</strong>
          <small>通过审批编号连接；未确认审批不会传入，未匹配数据仍保留在同一张表且不写入异常清单。</small>
        </div>
        <span>${rows.length} 行</span>
      </header>
      <div class="approval-union-scroll">
        <table class="approval-union-table" aria-label="银行与审批联合处理表">
          <colgroup>
            <col class="approval-union-col-bank-date">
            <col class="approval-union-col-bank-serial">
            <col class="approval-union-col-bank-party">
            <col class="approval-union-col-bank-amount">
            <col class="approval-union-col-reference">
            <col class="approval-union-col-status">
            <col class="approval-union-col-difference">
            <col class="approval-union-col-approval-date">
            <col class="approval-union-col-approval-template">
            <col class="approval-union-col-approval-content">
            <col class="approval-union-col-approval-amount">
            <col class="approval-union-col-account">
            <col class="approval-union-col-scenario">
            <col class="approval-union-col-action">
          </colgroup>
          <thead>
            <tr class="approval-union-groups">
              <th colspan="4">银行数据</th>
              <th colspan="3">审批编号连接</th>
              <th colspan="5">审批数据（原始字段只读）</th>
              <th colspan="2">本地处理</th>
            </tr>
            <tr>
              <th>交易日期</th><th>流水号</th><th>收款方 / 银行账号</th><th>银行金额</th>
              <th>审批编号</th><th>匹配状态</th><th>金额差异</th>
              <th>业务日期</th><th>审批模板</th><th>申请内容</th><th>审批金额</th><th>科目</th>
              <th>凭证场景</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((row) => {
              const bank = row.bankEvent;
              const approval = row.approvalEvent;
              const status = unionStatusDetails(row.status);
              const voucher = voucherForUnionRow(row);
              const selection = state.approvalUnionSelections[row.id] || {};
              const autoRule = autoRuleForUnionRow(row);
              return `
                <tr data-union-row="${escapeHtml(row.id)}">
                  <td>${escapeHtml(bank?.date || "—")}</td>
                  <td><strong>${escapeHtml(unionBankSerial(bank))}</strong></td>
                  <td><strong>${escapeHtml(bank?.counterparty || "—")}</strong><small>${escapeHtml(bank?.bankAccount || bank?.accountNo || "")}</small></td>
                  <td class="money">${Number.isInteger(row.bankSignedAmountCents) ? formatMoney(row.bankSignedAmountCents) : "—"}</td>
                  <td>
                    ${approval ? `
                      <button
                        class="approval-record-number"
                        type="button"
                        data-open-approval-detail="${escapeHtml(approval.id)}"
                        aria-label="查看审批单 ${escapeHtml(row.reference || approval.id)} 的完整数据"
                      >
                        <strong>${escapeHtml(row.reference || "—")}</strong>
                      </button>
                    ` : `<strong>${escapeHtml(row.reference || "—")}</strong>`}
                  </td>
                  <td><span class="status-pill ${status.tone}">${escapeHtml(status.label)}</span></td>
                  <td class="money ${row.amountDifferenceCents ? "difference" : ""}">
                    ${Number.isInteger(row.amountDifferenceCents) ? formatMoney(row.amountDifferenceCents) : "—"}
                  </td>
                  <td>${escapeHtml(approval?.date || "—")}</td>
                  <td><strong>${escapeHtml(approval?.approvalName || "—")}</strong><small>${escapeHtml(approval?.approvalStatus || "")}</small></td>
                  <td><strong>${escapeHtml(approval?.counterparty || "—")}</strong><small>${escapeHtml([approval?.department, approval?.project].filter(Boolean).join(" / "))}</small></td>
                  <td class="money">${Number.isInteger(row.approvalAmountCents) ? formatMoney(row.approvalAmountCents) : "—"}</td>
                  <td>
                    ${approval ? `
                      <select data-union-account-event="${escapeHtml(approval.id)}" ${voucher ? "disabled" : ""} aria-label="${escapeHtml(row.reference)} 的科目">
                        ${approvalProcessingAccountOptions(accounts, approval.debitAccountMasterDataId || "")}
                      </select>
                    ` : `<span class="approval-union-empty">无审批记录</span>`}
                  </td>
                  <td>
                    <select data-union-rule-row="${escapeHtml(row.id)}" ${voucher ? "disabled" : ""} aria-label="${escapeHtml(row.reference)} 的凭证场景">
                      ${unionRuleOptions(selection.ruleId || "")}
                    </select>
                    ${autoRule && !voucher ? `<small>自动命中：${escapeHtml(autoRule.name)}</small>` : ""}
                  </td>
                  <td>
                    ${voucher
                      ? `<button class="quiet-button compact" data-route="vouchers">查看 ${escapeHtml(voucher.number)}</button>`
                      : `<button class="primary-button compact" data-generate-union-row="${escapeHtml(row.id)}" ${row.status === "matched" ? (autoRule || selection.ruleId ? "" : "disabled") : (selection.ruleId ? "" : "disabled")}>
                          ${row.status === "matched" && !selection.ruleId ? "自动生成" : "按场景生成"}
                        </button>`}
                  </td>
                </tr>
              `;
            }).join("") : `
              <tr><td colspan="14"><div class="empty-state">${icon("briefcase")}<h3>尚无银行或审批数据</h3><p>完成银行流水导入或审批同步后，这里会显示全量联合结果。</p></div></td></tr>
            `}
          </tbody>
        </table>
      </div>
    </section>
    ${approvalRecordDetailModal(detailRecord, detailConnector)}
  `;
}

function connectorsPage() {
  const connectorItems = state.connectors || [];
  if (!connectorItems.length) {
    return `<section class="page-heading compact"><div><h1>连接器</h1><p>连接器由接入方案创建，不提供演示连接器。</p></div><button class="primary-button" data-route="plan">配置接入方案</button></section>${readonlyWorkspaceEmpty("尚未配置真实系统")}`;
  }
  if (!connectorItems.some((item) => item.id === selectedConnectorId)) {
    selectedConnectorId = connectorItems[0].id;
  }
  const connector = connectorItems.find((item) => item.id === selectedConnectorId);
  const isFeishu = connector.adapter === "feishu-approval-v4";
  const isOaJson = connector.adapter === "oa-json-api";
  const isKingdee = connector.adapter === "kingdee-k3cloud-webapi-v6";
  const isWorkflow = connector.type === "workflow";
  const maskedSecretPlaceholder = connector.status === "not_configured"
    ? ""
    : CONFIG_VALUE_MASK;
  const statusLabel = {
    connected: "测试通过",
    configured: "待测试",
    error: "配置失效",
    not_configured: "未配置",
  }[connector.status] || "未配置";
  const probeChecks = (connector.lastProbe?.checks || []).map((item) => {
    const detail = item.name === "目标范围" ? CONFIG_VALUE_MASK : item.detail;
    return `<li class="${item.status}"><span>${item.status === "passed" ? icon("check") : icon("alert")}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(detail)}</small></div></li>`;
  }).join("");
  return `
    <section class="page-heading compact connector-page-heading">
      <div><h1>连接器</h1><p>填写服务商提供的连接信息；密钥只保存到系统密钥库。</p></div>
    </section>
    ${connectorJob ? `<div class="job-progress"><div><strong>后台同步任务</strong><span>${connectorJob.status}</span></div><progress max="100" value="${connectorJob.progress?.percent || 20}"></progress></div>` : ""}
    <section class="connector-workspace glass-panel">
      <aside class="connector-catalog">
        <div class="connector-catalog-heading"><strong>已添加系统</strong><small>${connectorItems.length} 个</small></div>
        <div class="connector-catalog-list">${connectorItems.map((item) => `<button class="${item.id === connector.id ? "active" : ""}" data-select-connector="${item.id}"><span class="connector-list-icon">${icon(item.type === "finance" ? "voucher" : "briefcase")}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.environment)}</small></span><span class="connector-state ${item.status === "connected" ? "success" : item.status === "error" ? "warning" : "pending"}"><i></i>${item.status === "connected" ? "可用" : "待配置"}</span></button>`).join("")}</div>
      </aside>
      <article class="connector-detail">
        <header class="connector-detail-header">
          <div class="connector-detail-identity"><span class="connector-detail-icon">${icon(connector.type === "finance" ? "voucher" : "briefcase")}</span><div><div class="connector-detail-meta"><span>${connector.type === "finance" ? "目标 ERP" : "数据来源"}</span><span>${escapeHtml(connector.environment)}</span><span class="connector-state ${connector.status === "connected" ? "success" : "pending"}"><i></i>${statusLabel}</span></div><h2>${escapeHtml(connector.name)}</h2><p>${isWorkflow ? "通过只读 API 获取 JSON，原始响应本地归档后再按映射生成业务事项。" : "只保存凭证草稿并回查真实外部编号；不提交、审核或过账。"}</p></div></div>
          <div class="connector-header-actions"><button class="secondary-button" data-test-real="${connector.id}">${icon("refresh")}测试连接</button><button class="primary-button" data-save-connector="${connector.id}">${icon("check")}保存配置</button></div>
        </header>
        <form class="connector-form connector-detail-form" data-connector-form="${connector.id}">
          <section class="connector-config-section">
            <div class="connector-section-heading"><div><h3>连接信息</h3><p>其他技术设置已由系统处理，无需填写。</p></div></div>
            <div class="connector-field-grid connector-basic-fields">
              ${isFeishu ? `
                <label><span>开放平台</span><select name="platform">
                  <option value="" ${connector.platform ? "" : "selected"}></option>
                  ${connector.platform ? `<option value="${CONFIG_VALUE_MASK}" selected>${CONFIG_VALUE_MASK}</option>` : ""}
                  <option value="feishu">中国大陆飞书</option>
                  <option value="lark">海外 Lark</option>
                </select></label>
                <label><span>App ID</span><input name="appId" value="${maskedConfigValue(connector.appId)}" autocomplete="username" required /></label>
                <label><span>App Secret</span><input name="secret" type="password" data-secret-input autocomplete="new-password" placeholder="${maskedSecretPlaceholder}" /></label>
                <p class="connector-field-note wide-field">基础连接只验证 App ID、App Secret 和平台域名；连接成功不代表已有审批模板读取权限。</p>
              ` : isOaJson ? `
                <label><span>API 网址</span><input name="baseUrl" value="${maskedConfigValue(connector.baseUrl)}" inputmode="url" required /></label>
                <label><span>密码 / 访问密钥</span><input name="secret" type="password" data-secret-input autocomplete="new-password" placeholder="${maskedSecretPlaceholder}" /></label>
              ` : isKingdee ? `
                <label class="wide-field"><span>K3Cloud WebAPI 地址</span><input name="serverUrl" value="${maskedConfigValue(connector.serverUrl)}" inputmode="url" required /></label>
                <label><span>API 账套 ID（AcctID）</span><input name="acctId" value="${maskedConfigValue(connector.acctId)}" autocomplete="off" required /></label>
                <label><span>API 用户名</span><input name="username" value="${maskedConfigValue(connector.username)}" autocomplete="username" required /></label>
                <label><span>第三方应用 ID（AppID）</span><input name="appId" value="${maskedConfigValue(connector.appId)}" autocomplete="off" required /></label>
                <label><span>第三方应用密钥（AppSecret）</span><input name="secret" type="password" data-secret-input autocomplete="new-password" placeholder="${maskedSecretPlaceholder}" /></label>
                <label><span>登录组织编码</span><input name="orgNum" value="${maskedConfigValue(connector.orgNum)}" autocomplete="off" /></label>
                <label><span>凭证账簿编号（FNumber）</span><input name="ledger" value="${maskedConfigValue(connector.ledger)}" autocomplete="off" required /></label>
              ` : `
                <label><span>API 网址</span><input name="baseUrl" value="${maskedConfigValue(connector.baseUrl)}" inputmode="url" required /></label>
                <label><span>账号</span><input name="username" value="${maskedConfigValue(connector.username)}" autocomplete="username" required /></label>
                <label><span>密码</span><input name="secret" type="password" data-secret-input autocomplete="new-password" placeholder="${maskedSecretPlaceholder}" /></label>
              `}
            </div>
          </section>
          ${probeChecks ? `<section class="connector-config-section"><div class="connector-section-heading"><div><h3>最近连接检查</h3></div></div><ul class="probe-checks connector-probe-list">${probeChecks}</ul></section>` : ""}
        </form>
        <footer class="connector-detail-footer"><p>${icon("shield")}任何系统均只读获取来源数据；凭证目标只保存草稿，不自动提交、审核或过账。</p><div>${isFeishu ? `<button class="secondary-button" data-route="approvals">配置审批数据</button>` : isWorkflow ? `<button class="secondary-button" data-sync-approvals="${connector.id}" ${connector.status === "connected" ? "" : "disabled"}>同步 OA 数据</button>` : `<button class="secondary-button" data-sync-master="${connector.id}" ${connector.status !== "connected" ? "disabled" : ""}>同步基础资料</button>`}<button class="quiet-button" data-activate-${isWorkflow ? "workflow" : "finance"}="${connector.id}">设为当前${isWorkflow ? "来源" : "目标"}</button></div></footer>
      </article>
    </section>
  `;
}

function ocrPage() {
  const ocrDocuments = state.sourceDocuments.filter((document) =>
    ["pending_ocr", "ocr_candidates", "ocr_confirmed", "text_extracted"].includes(document.extractionStatus));
  const pending = ocrDocuments.filter((document) =>
    ["pending_ocr", "ocr_candidates"].includes(document.extractionStatus));
  const statusLabel = {
    pending_ocr: "等待 OCR",
    ocr_candidates: "候选待确认",
    ocr_confirmed: "已人工确认",
    text_extracted: "已提取文本",
  };
  return `
    <section class="page-heading compact">
      <div>
        <span class="eyebrow">本地工具</span>
        <h1>OCR</h1>
        <p>识别 PDF 与图片中的候选字段。低置信度结果不会自动生成凭证，必须由财务人员确认。</p>
      </div>
      <div class="heading-actions">
        ${pending.length ? `<button class="secondary-button" data-route="exceptions">${icon("alert")}确认 ${pending.length} 份候选</button>` : ""}
        <button class="primary-button" data-route="import">${icon("upload")}导入票据</button>
      </div>
    </section>
    <section class="tool-summary">
      <article class="glass-panel"><span>相关资料</span><strong>${ocrDocuments.length}</strong><small>份 PDF 或图片</small></article>
      <article class="glass-panel ${pending.length ? "attention" : "success"}"><span>等待人工处理</span><strong>${pending.length}</strong><small>份候选资料</small></article>
      <article class="glass-panel"><span>处理原则</span><strong>人工确认</strong><small>识别结果不自动入账</small></article>
    </section>
    <section class="ocr-document-list glass-panel">
      <div class="panel-heading"><div><span class="eyebrow">处理记录</span><h2>票据识别状态</h2></div></div>
      ${ocrDocuments.length ? ocrDocuments.map((document) => `
        <article>
          <span class="ocr-document-icon">${icon("scan")}</span>
          <span><strong>${escapeHtml(document.name)}</strong><small>${escapeHtml(document.type)} · ${escapeHtml(document.hash)}</small></span>
          <span>${document.ocrConfidence ? `${Math.round(document.ocrConfidence * 100)}% 置信度` : "未生成置信度"}</span>
          <span class="status-pill ${["ocr_confirmed", "text_extracted"].includes(document.extractionStatus) ? "success" : "pending"}">${statusLabel[document.extractionStatus]}</span>
        </article>
      `).join("") : `<div class="empty-state">${icon("scan")}<p>尚无需要 OCR 的 PDF 或图片资料。</p></div>`}
    </section>
  `;
}

const diagnosticCategoryLabels = {
  application: "应用运行",
  http: "本地接口",
  frontend: "页面界面",
  import: "数据导入",
  voucher: "凭证处理",
  connector: "外部连接器",
  background_job: "后台任务",
  storage: "本地存储",
  backup: "备份恢复",
  security: "安全控制",
  environment: "环境检测",
  update: "版本更新",
  launcher: "轻量启动器",
};

const diagnosticLevelLabels = {
  DEBUG: "调试",
  INFO: "正常",
  WARNING: "提醒",
  ERROR: "错误",
  CRITICAL: "严重",
};

function diagnosticSince(days) {
  return new Date(Date.now() - Number(days || 7) * 24 * 60 * 60 * 1000).toISOString();
}

async function refreshDiagnostics({ keepPage = false } = {}) {
  if (!keepPage) diagnosticPage = 0;
  diagnosticLoading = true;
  if (route === "diagnostics") render();
  try {
    const [logs, summary] = await Promise.all([
      fetchDiagnosticLogs({
        level: diagnosticFilters.level,
        category: diagnosticFilters.category,
        search: diagnosticFilters.search,
        from: diagnosticSince(diagnosticFilters.days),
        limit: 100,
        offset: diagnosticPage * 100,
      }),
      fetchDiagnosticSummary(24),
    ]);
    diagnosticResult = logs;
    diagnosticSummary = summary;
  } catch (error) {
    toast(error.message, "warning");
  } finally {
    diagnosticLoading = false;
    if (route === "diagnostics") render();
  }
}

function diagnosticCopyText(entry) {
  return [
    "Auto Voucher 诊断日志",
    `时间：${formatDate(entry.occurredAt, true)}`,
    `级别：${diagnosticLevelLabels[entry.level] || entry.level}`,
    `模块：${diagnosticCategoryLabels[entry.category] || entry.category}`,
    `事件代码：${entry.eventCode}`,
    `问题：${entry.message}`,
    entry.userAction ? `建议操作：${entry.userAction}` : "",
    entry.correlationId ? `支持编号：${entry.correlationId}` : "",
    entry.operation ? `操作：${entry.operation}` : "",
    entry.subjectId ? `对象：${entry.subjectType || "业务对象"} ${entry.subjectId}` : "",
    entry.durationMs !== null && entry.durationMs !== undefined ? `耗时：${entry.durationMs} ms` : "",
    `应用版本：${entry.appVersion}`,
    `技术上下文：${JSON.stringify(entry.context || {}, null, 2)}`,
    Object.keys(entry.error || {}).length ? `错误详情：${JSON.stringify(entry.error, null, 2)}` : "",
  ].filter(Boolean).join("\n");
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the visible, user-controlled copy surface.
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) showCopyFallback(value);
    return copied;
  } catch {
    area.remove();
    showCopyFallback(value);
    return false;
  }
}

function showCopyFallback(value) {
  document.querySelector("[data-copy-fallback]")?.remove();
  const layer = document.createElement("div");
  layer.className = "modal-layer";
  layer.dataset.copyFallback = "true";
  layer.innerHTML = `
    <section class="glass-panel copy-fallback-modal" role="dialog" aria-modal="true" aria-labelledby="copy-fallback-title">
      <div class="panel-heading"><div><h2 id="copy-fallback-title">手动复制问题信息</h2><p>剪贴板权限不可用，请全选文本复制，或下载 TXT。</p></div></div>
      <textarea readonly>${escapeHtml(value)}</textarea>
      <div class="card-actions"><button class="secondary-button" data-download-copy-text>下载 TXT</button><button class="primary-button" data-close-copy-fallback>完成</button></div>
    </section>`;
  document.body.append(layer);
  const area = layer.querySelector("textarea");
  area.focus();
  area.select();
  layer.querySelector("[data-close-copy-fallback]").addEventListener("click", () => layer.remove());
  layer.querySelector("[data-download-copy-text]").addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
    link.download = `AutoVoucher问题信息_${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

function diagnosticsPage() {
  const settings = diagnosticSummary.settings || { retentionDays: 30, maxEntries: 50000 };
  const errorCount = (diagnosticSummary.byLevel?.ERROR || 0) + (diagnosticSummary.byLevel?.CRITICAL || 0);
  const warningCount = diagnosticSummary.byLevel?.WARNING || 0;
  const totalPages = Math.max(1, Math.ceil((diagnosticResult.total || 0) / 100));
  return `
    <section class="page-heading diagnostics-heading">
      <div>
        <span class="eyebrow">本地问题定位</span>
        <h1>诊断日志</h1>
        <p>这里记录程序运行、导入、后台任务和连接器故障。日志已自动脱敏，可复制单条记录或导出诊断包给技术支持。</p>
      </div>
      <div class="heading-actions">
        <button class="secondary-button" data-copy-diagnostic-summary>${icon("file")}一键复制问题信息</button>
        <select data-diagnostic-export-days aria-label="诊断包时间范围">
          <option value="1">最近 1 天</option>
          <option value="7" selected>最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="90">最近 90 天</option>
        </select>
        <button class="primary-button" data-export-diagnostics>${icon("download")}导出脱敏诊断包</button>
      </div>
    </section>
    <section class="diagnostic-summary-grid">
      <article class="diagnostic-stat glass-panel"><span>最近 24 小时</span><strong>${diagnosticSummary.total || 0}</strong><small>条运行记录</small></article>
      <article class="diagnostic-stat glass-panel error"><span>需要关注</span><strong>${errorCount}</strong><small>条错误或严重问题</small></article>
      <article class="diagnostic-stat glass-panel warning"><span>操作提醒</span><strong>${warningCount}</strong><small>条可恢复提醒</small></article>
      <article class="diagnostic-stat glass-panel"><span>自动保留</span><strong>${settings.retentionDays}</strong><small>天 · 上限 ${Number(settings.maxEntries).toLocaleString()} 条</small></article>
    </section>
    ${diagnosticSummary.latestError ? `
      <article class="latest-diagnostic-error">
        ${icon("alert")}<div><span>最近错误 · ${formatDate(diagnosticSummary.latestError.occurredAt, true)}</span><strong>${escapeHtml(diagnosticSummary.latestError.message)}</strong><small>${escapeHtml(diagnosticSummary.latestError.userAction || "可复制支持编号并导出诊断包")}</small></div>
        <button class="secondary-button" data-copy-diagnostic="${diagnosticSummary.latestError.id}">复制</button>
      </article>
    ` : ""}
    <section class="diagnostic-toolbar glass-panel">
      <label><span>级别</span><select data-diagnostic-filter="level">
        <option value="">全部级别</option>
        ${(diagnosticResult.filters?.levels || ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]).map((level) => `
          <option value="${level}" ${diagnosticFilters.level === level ? "selected" : ""}>${diagnosticLevelLabels[level] || level}</option>
        `).join("")}
      </select></label>
      <label><span>模块</span><select data-diagnostic-filter="category">
        <option value="">全部模块</option>
        ${(diagnosticResult.filters?.categories || Object.keys(diagnosticCategoryLabels)).map((category) => `
          <option value="${category}" ${diagnosticFilters.category === category ? "selected" : ""}>${diagnosticCategoryLabels[category] || category}</option>
        `).join("")}
      </select></label>
      <label><span>时间范围</span><select data-diagnostic-filter="days">
        <option value="1" ${diagnosticFilters.days === "1" ? "selected" : ""}>最近 1 天</option>
        <option value="7" ${diagnosticFilters.days === "7" ? "selected" : ""}>最近 7 天</option>
        <option value="30" ${diagnosticFilters.days === "30" ? "selected" : ""}>最近 30 天</option>
        <option value="90" ${diagnosticFilters.days === "90" ? "selected" : ""}>最近 90 天</option>
      </select></label>
      <label class="diagnostic-search"><span>关键词 / 支持编号</span><input data-diagnostic-search value="${escapeHtml(diagnosticFilters.search)}" placeholder="例如：导入失败、REQ-…" /></label>
      <button class="secondary-button" data-refresh-diagnostics>${icon("refresh")}刷新</button>
      <button class="secondary-button" data-copy-visible ${!diagnosticResult.items.length ? "disabled" : ""}>复制当前页</button>
    </section>
    <section class="diagnostic-list glass-panel" aria-busy="${diagnosticLoading}">
      <div class="panel-heading">
        <div><span class="eyebrow">结构化运行记录</span><h2>${diagnosticLoading ? "正在读取…" : `${diagnosticResult.total || 0} 条结果`}</h2></div>
        <small>业务审计日志不会在这里删除或修改</small>
      </div>
      ${diagnosticLoading ? `<div class="diagnostic-loading">正在读取本地日志…</div>` : diagnosticResult.items.length ? diagnosticResult.items.map((entry) => `
        <article class="diagnostic-entry level-${entry.level.toLowerCase()}">
          <div class="diagnostic-entry-main">
            <span class="diagnostic-level">${diagnosticLevelLabels[entry.level] || entry.level}</span>
            <div>
              <div class="diagnostic-entry-title"><strong>${escapeHtml(entry.message)}</strong><code>${escapeHtml(entry.eventCode)}</code></div>
              <p>${escapeHtml(entry.userAction || "无需操作")}</p>
              <small>${formatDate(entry.occurredAt, true)} · ${escapeHtml(diagnosticCategoryLabels[entry.category] || entry.category)}${entry.durationMs !== null ? ` · ${entry.durationMs} ms` : ""}${entry.correlationId ? ` · 支持编号 ${escapeHtml(entry.correlationId)}` : ""}</small>
            </div>
          </div>
          <div class="diagnostic-entry-actions">
            <button class="text-button" data-copy-diagnostic="${entry.id}">复制</button>
            <details>
              <summary>技术详情</summary>
              <pre>${escapeHtml(JSON.stringify({ context: entry.context, error: entry.error }, null, 2))}</pre>
            </details>
          </div>
        </article>
      `).join("") : `<div class="empty-state">${icon("check")}<p>当前筛选范围内没有日志。</p></div>`}
      <div class="diagnostic-pagination">
        <button class="secondary-button" data-diagnostic-page="-1" ${diagnosticPage <= 0 ? "disabled" : ""}>上一页</button>
        <span>第 ${diagnosticPage + 1} / ${totalPages} 页</span>
        <button class="secondary-button" data-diagnostic-page="1" ${diagnosticPage + 1 >= totalPages ? "disabled" : ""}>下一页</button>
      </div>
    </section>
    <section class="diagnostic-retention glass-panel">
      <div><span class="eyebrow">存储控制</span><h2>日志保留策略</h2><p>只清理诊断日志，不影响财务审计记录、凭证或原始资料。</p></div>
      <label><span>保留天数</span><input data-retention-days type="number" min="7" max="365" value="${settings.retentionDays}" /></label>
      <label><span>最大条数</span><input data-max-diagnostic-entries type="number" min="5000" max="500000" step="5000" value="${settings.maxEntries}" /></label>
      <button class="secondary-button" data-save-diagnostic-settings>保存策略</button>
    </section>
    <article class="boundary-card">
      ${icon("shield")}<div><strong>诊断包安全边界</strong><p>不包含原始票据、凭证分录、数据库、密钥、令牌或完整账号。发送前仍建议财务人员检查 ZIP 内的 README 和 JSON 文件。</p></div>
    </article>
  `;
}

function settingsPage() {
  const masterData = (state.masterData || []).filter((item) => item.active !== false);
  const masterCounts = Object.entries(masterData.reduce((result, item) => {
    const label = item.categoryLabel
      || masterDataCategoryLabels[item.category]
      || "其他基础资料";
    result[label] = (result[label] || 0) + 1;
    return result;
  }, {}));
  return `
    <section class="page-heading">
      <div><span class="eyebrow">设置</span><h1>通用设置</h1><p>管理本机操作者与基础资料版本。日志和备份使用设置下的独立入口。</p></div>
    </section>
    <section class="settings-grid">
      ${environmentCard()}
      ${updateCard()}
      <article class="settings-card glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">操作者</span><h2>本机身份</h2></div></div>
        <label>操作者名称<input data-operator-input value="${escapeHtml(state.operator)}" /></label>
        <label>公司<input value="${escapeHtml(state.company)}" disabled /></label>
        <label>账簿<input value="${escapeHtml(state.ledger)}" disabled /></label>
        <button class="primary-button" data-save-operator>保存设置</button>
      </article>
      <article class="settings-card glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">基础资料</span><h2>当前有效版本</h2></div><button class="text-button" data-route="import">导入更新</button></div>
        <p>科目、客商和辅助核算按“类型 + 编码”保留历史版本，既有凭证不会被静默改写。</p>
        <div class="master-summary">${masterCounts.length
          ? masterCounts.map(([label, count]) => `<span><strong>${count}</strong>${escapeHtml(label)}</span>`).join("")
          : `<span class="muted-copy">尚未导入企业基础资料，不能启用生产规则。</span>`}</div>
      </article>
      <article class="settings-card glass-panel settings-route-card">
        <div class="panel-heading"><div><span class="eyebrow">支持</span><h2>诊断日志</h2></div>${icon("file")}</div>
        <p>查看经过脱敏的程序日志，并导出诊断包给技术支持。</p>
        <button class="secondary-button" data-route="diagnostics">打开诊断日志</button>
      </article>
      <article class="settings-card glass-panel settings-route-card">
        <div class="panel-heading"><div><span class="eyebrow">本地数据</span><h2>备份与恢复</h2></div>${icon("download")}</div>
        <p>导出完整备份、恢复已有备份，或执行受保护的全量初始化。</p>
        <button class="secondary-button" data-route="backup">打开备份与恢复</button>
      </article>
    </section>
  `;
}

function backupPage() {
  return `
    <section class="page-heading">
      <div>
        <span class="eyebrow">设置 · 本地数据</span>
        <h1>备份与恢复</h1>
        <p>备份包包含业务数据、凭证、规则、审计记录和原始文件归档，不包含任何外部系统密钥。</p>
      </div>
    </section>
    <section class="backup-layout">
      <article class="settings-card glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">安全副本</span><h2>导出备份</h2></div>${icon("download")}</div>
        <p>将当前 SQLite 业务状态和原始文件归档导出为 ZIP，适合迁移或定期留存。</p>
        <button class="primary-button" data-backup>${icon("download")}导出完整备份</button>
      </article>
      <article class="settings-card glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">校验后覆盖</span><h2>恢复备份</h2></div>${icon("upload")}</div>
        <p>选择文件后先验证包类型、版本和数据范围，确认前不会覆盖当前数据。</p>
        <label class="secondary-button file-label">${icon("upload")}选择备份文件<input data-restore type="file" accept=".zip" hidden /></label>
      </article>
      <article class="settings-card glass-panel danger-zone">
        <div class="panel-heading"><div><span class="eyebrow">危险操作</span><h2>全量初始化</h2></div>${icon("alert")}</div>
        <p>先生成完整性校验备份，再清除业务状态、原件归档、浏览器旧缓存和已知连接器密钥。</p>
        <button class="danger-button" data-reset-demo>备份并全量初始化</button>
      </article>
    </section>
  `;
}

function currentPage() {
  const pages = {
    plan: planPage,
    systems: systemsPage,
    dashboard: dashboardPage,
    bank: () => eventsPage("bank"),
    business: () => eventsPage("business"),
    depreciation: () => eventsPage("depreciation"),
    import: importPage,
    events: eventsPage,
    vouchers: vouchersPage,
    delivery: deliveryPage,
    templates: templatesPage,
    exceptions: exceptionsPage,
    rules: rulesPage,
    connectors: connectorsPage,
    approvals: approvalDataPage,
    approvalProcessing: approvalProcessingPage,
    ocr: ocrPage,
    diagnostics: diagnosticsPage,
    settings: settingsPage,
    backup: backupPage,
  };
  return pages[route]();
}

function shell() {
  if (serviceError) {
    return `
      <div class="app-backdrop"><i></i><i></i><i></i></div>
      <main class="service-blocked">
        <article class="glass-panel empty-state">
          ${icon("alert")}<h1>本地服务不可用</h1>
          <p>${escapeHtml(serviceError)}</p>
          <p>生产模式不会从浏览器缓存恢复示例数据。请启动本地 Auto Voucher 服务后刷新。</p>
          <button class="primary-button" data-reload-app>${icon("refresh")}重新加载</button>
        </article>
      </main>
    `;
  }
  return `
    <div class="app-backdrop"><i></i><i></i><i></i></div>
    <div class="app-shell ${route === "dashboard" ? "workflow-shell" : ""}">
      ${sidebar()}
      <main class="content ${route === "dashboard" ? "dashboard-content" : route === "connectors" ? "connector-content" : route === "approvals" ? "approval-content" : route === "approvalProcessing" ? "approval-processing-content" : ""}">
        ${["import", "dashboard", "approvals", "approvalProcessing"].includes(route) ? "" : `<div class="global-search-anchor">${globalSearchBox()}</div>`}
        ${["dashboard", "approvals"].includes(route) ? "" : workflowReturnBar()}
        ${currentPage()}
      </main>
    </div>
    ${runtimeStatusDialog()}
    <div class="toast-region" aria-live="polite"></div>
  `;
}

function toast(message, tone = "success") {
  const region = document.querySelector(".toast-region");
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.innerHTML = `${icon(tone === "success" ? "check" : "alert")}<span>${escapeHtml(message)}</span>`;
  region.append(item);
  setTimeout(() => item.remove(), 3200);
}

function fileKind(name) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "csv") return { kind: "结构化表格", action: "解析字段并创建业务事项" };
  if (extension === "txt") return { kind: "分隔文本", action: "按逗号、分号、制表符或竖线解析" };
  if (extension === "xml") return { kind: "结构化 XML", action: "归档并提取基础元数据" };
  if (extension === "xlsx") return { kind: "Excel", action: "解析字段并创建业务事项" };
  if (extension === "xls") return { kind: "旧版 Excel", action: "解析字段并创建业务事项" };
  if (extension === "pdf") return { kind: "PDF", action: "归档并尝试提取文本" };
  if (["png", "jpg", "jpeg"].includes(extension)) return { kind: "图片", action: "本地 OCR 生成候选并等待人工确认" };
  return { kind: "未知格式", action: "不支持" };
}

async function addFiles(files) {
  pendingFiles = [...pendingFiles, ...[...files].map((file) => ({ file, ...fileKind(file.name) }))];
  importPreview = null;
  importPreviewError = "";
  fieldMapping = {};
  mappingTemplateName = "";
  const singleStructuredImport = pendingFiles.length === 1 && /\.(csv|txt|xls|xlsx)$/i.test(pendingFiles[0].file.name);
  importPreviewLoading = singleStructuredImport;
  render();
  if (singleStructuredImport) {
    try {
      importPreview = await previewImportFile(pendingFiles[0].file);
      fieldMapping = { ...importPreview.suggestedMapping };
      fieldMapping.amount = normalizeMappingSelection(fieldMapping.amount);
      mappingTemplateName = importPreview.matchedTemplate?.name || "";
      importPreviewLoading = false;
      render();
    } catch (error) {
      importPreviewLoading = false;
      importPreviewError = error.message;
      render();
      toast(`无法预览字段：${error.message}`, "warning");
    }
  }
}

async function runImport() {
  if (!pendingFiles.length) return;
  const singleStructuredImport = pendingFiles.length === 1 && /\.(csv|txt|xls|xlsx)$/i.test(pendingFiles[0].file.name);
  if (importPreviewError || (singleStructuredImport && !importPreview)) {
    toast("字段预览尚未成功，请移除文件后重新选择", "warning");
    return;
  }
  const paymentAmountFields = normalizeMappingSelection(fieldMapping.amount);
  if (importPreview?.kind !== "masterData" && importPreview && (!fieldMapping.counterparty || !paymentAmountFields.length)) {
    toast("请选择“供应商 / 客商”和至少一个“付款金额”字段", "warning");
    return;
  }
  fieldMapping.amount = paymentAmountFields;
  try {
    importProgress = { status: "queued", progress: { processed: 0, total: pendingFiles.length, percent: 0 } };
    render();
    const result = await importFiles(pendingFiles.map((item) => item.file), {
      mapping: importPreview?.kind === "businessData" ? fieldMapping : null,
      templateName: mappingTemplateName,
      onProgress: (job) => {
        importProgress = job;
        render();
      },
    });
    state = result.state;
    importResult = result;
    pendingFiles = [];
    importPreview = null;
    importPreviewError = "";
    importPreviewLoading = false;
    fieldMapping = {};
    mappingTemplateName = "";
    importProgress = null;
    render();
    toast(`导入完成：成功 ${result.success}，重复 ${result.duplicate}，失败 ${result.failed}`, result.failed ? "warning" : "success");
  } catch (error) {
    importProgress = null;
    render();
    toast(error.message, "warning");
  }
}

function buildVoucherForEvent(event) {
  const candidates = matchingPostingRules(state.rules, event);
  const rule = candidates[0] || selectPostingRule(state.rules, event);
  if (!rule) throw new Error("未命中已启用的完整凭证场景");
  const voucher = createPurchaseVoucher(
    event,
    state.vouchers.length + 1,
    rule,
    ruleEditorContext({ resolveDimensionMasterData: true }),
  );
  voucher.ruleSelection = {
    selectedRuleId: rule?.id || null,
    selectedRuleVersion: rule?.version || null,
    candidateRuleIds: candidates.map((item) => item.id),
    conflict: candidates.length > 1,
    explanation: candidates.length > 1
      ? `共有 ${candidates.length} 条规则命中，按优先级选择 ${rule.name}（${rule.priority}）`
      : `唯一命中 ${rule.name}`,
  };
  return { voucher, rule };
}

function buildVoucherForUnionRow(row, ruleId = "") {
  if (!row || voucherForUnionRow(row)) throw new Error("该联合数据已经生成凭证草稿");
  const event = buildUnionVoucherEvent(row);
  const explicitRule = ruleId
    ? (state.rules || []).find((item) =>
      item.id === ruleId && item.enabled && postingRuleComplete(item))
    : null;
  if (ruleId && !explicitRule) throw new Error("所选凭证场景未启用或分录不完整");
  const candidates = matchingPostingRules(state.rules || [], event);
  const rule = explicitRule || candidates[0];
  if (!rule) {
    throw new Error(
      row.status === "matched"
        ? "没有自动命中的已启用凭证场景"
        : "请先手动选择已启用的凭证场景",
    );
  }
  if (!explicitRule && row.status !== "matched") {
    throw new Error("未匹配数据必须由用户手动选择凭证场景");
  }
  if (!explicitRule && !validApprovalAccount(row.approvalEvent)) {
    throw new Error("自动生成前必须为审批记录选择有效科目");
  }
  const voucher = createPurchaseVoucher(
    event,
    state.vouchers.length + 1,
    rule,
    {
      ...ruleEditorContext({ resolveDimensionMasterData: true }),
      sourceEventIds: row.sourceEventIds,
    },
  );
  if (!voucher.validation?.valid) {
    throw new Error(voucher.validation?.errors?.[0] || "凭证草稿校验未通过");
  }
  voucher.ruleSelection = {
    selectedRuleId: rule.id,
    selectedRuleVersion: rule.version,
    candidateRuleIds: candidates.map((item) => item.id),
    conflict: !explicitRule && candidates.length > 1,
    explanation: explicitRule
      ? `用户在银行与审批联合表中手动选择 ${rule.name}（${rule.version}）`
      : candidates.length > 1
        ? `共有 ${candidates.length} 个场景命中，按优先级选择 ${rule.name}（${rule.priority}）`
        : `匹配且金额一致，自动应用 ${rule.name}`,
  };
  voucher.approvalBankUnion = {
    rowId: row.id,
    reference: row.reference,
    status: row.status,
    bankEventId: row.bankEvent?.id || null,
    approvalEventId: row.approvalEvent?.id || null,
    bankAmountCents: row.bankAmountCents,
    approvalAmountCents: row.approvalAmountCents,
    amountDifferenceCents: row.amountDifferenceCents,
    selectionMode: explicitRule ? "manual" : "automatic",
  };
  return { voucher, rule };
}

async function generateVoucherForUnionRow(rowId) {
  const row = approvalBankUnionRows().find((item) => item.id === rowId);
  if (!row) return toast("联合数据行已变化，请刷新后重试", "warning");
  const ruleId = state.approvalUnionSelections?.[row.id]?.ruleId || "";
  try {
    const { voucher, rule } = buildVoucherForUnionRow(row, ruleId);
    state.vouchers.unshift(voucher);
    row.sourceEventIds.forEach((eventId) => {
      const source = state.events.find((item) => item.id === eventId);
      if (source) source.status = "已生成";
    });
    appendAudit(
      state,
      ruleId ? "手动选择场景生成凭证" : "联合匹配自动生成凭证",
      voucher.number,
      `审批编号 ${row.reference || "未提供"}；应用 ${rule.name}；来源 ${row.sourceEventIds.length} 项`,
    );
    await saveState(state);
    render();
    toast(`已生成 ${voucher.number}，应用 ${rule.name}`);
  } catch (error) {
    toast(error.message, "warning");
  }
}

async function updateSelectedApprovalTransfer(confirmed) {
  const selectedIds = [...selectedApprovalRecordIds];
  const beforeConfirmations = structuredClone(state.approvalProcessingConfirmations || {});
  const beforeAudit = structuredClone(state.auditLog || []);
  try {
    const confirmedAt = new Date().toISOString();
    const confirmedBy = state.operator || "本机操作者";
    state.approvalProcessingConfirmations = updateApprovalProcessingConfirmations({
      records: state.events || [],
      confirmations: state.approvalProcessingConfirmations || {},
      recordIds: selectedIds,
      confirmed,
      confirmedAt,
      confirmedBy,
    });
    const validRecords = (state.events || []).filter((record) =>
      selectedIds.includes(record.id) && isApprovalRecord(record));
    appendAudit(
      state,
      confirmed ? "确认传递审批数据" : "取消传递审批数据",
      `${validRecords.length} 条审批记录`,
      confirmed
        ? "所选审批记录已确认，可进入审批数据处理"
        : "所选审批记录已撤回，不再进入审批数据处理",
    );
    await saveState(state);
    selectedApprovalRecordIds.clear();
    render();
    toast(confirmed
      ? `已确认并传递 ${validRecords.length} 条审批记录`
      : `已取消 ${validRecords.length} 条审批记录的传递`);
  } catch (error) {
    state.approvalProcessingConfirmations = beforeConfirmations;
    state.auditLog = beforeAudit;
    render();
    toast(error.message, "warning");
  }
}

async function autoGenerateUnionVouchers() {
  const rows = approvalBankUnionRows().filter((row) =>
    !voucherForUnionRow(row) && autoRuleForUnionRow(row));
  if (!rows.length) return toast("当前没有可自动生成的匹配数据", "warning");
  const beforeVouchers = structuredClone(state.vouchers || []);
  const beforeEvents = structuredClone(state.events || []);
  const beforeAudit = structuredClone(state.auditLog || []);
  try {
    rows.forEach((row) => {
      const { voucher, rule } = buildVoucherForUnionRow(row);
      state.vouchers.unshift(voucher);
      row.sourceEventIds.forEach((eventId) => {
        const source = state.events.find((item) => item.id === eventId);
        if (source) source.status = "已生成";
      });
      appendAudit(
        state,
        "联合匹配自动生成凭证",
        voucher.number,
        `审批编号 ${row.reference}；金额一致；应用 ${rule.name}`,
      );
    });
    await saveState(state);
    render();
    toast(`已自动生成 ${rows.length} 张凭证草稿`);
  } catch (error) {
    state.vouchers = beforeVouchers;
    state.events = beforeEvents;
    state.auditLog = beforeAudit;
    render();
    toast(`自动生成已停止：${error.message}`, "warning");
  }
}

function generateVoucher(eventId) {
  const event = state.events.find((item) => item.id === eventId);
  if (!event || getVoucherForEvent(eventId)) return;
  let voucher;
  let rule;
  try {
    ({ voucher, rule } = buildVoucherForEvent(event));
  } catch {
    const existing = state.exceptions.find((item) =>
      item.eventId === event.id && item.type === "待配置规则" && item.status === "待处理");
    if (!existing) {
      const exceptionId = `EX-RULE-${Date.now()}`;
      state.exceptions.unshift({
        id: exceptionId,
        eventId: event.id,
        type: "待配置规则",
        severity: "阻断",
        title: `${event.reference} 尚无可用凭证场景`,
        detail: "系统未使用采购付款默认科目，也不会猜测借贷分录。",
        suggestion: "在“凭证场景”中配置科目、辅助核算和审批依据并经人工确认后启用。",
        status: "待处理",
      });
      event.exceptionIds ||= [];
      event.exceptionIds.push(exceptionId);
    }
    event.status = "待处理";
    persist("创建待配置事项", event.reference, "未命中已启用的完整凭证场景，未生成凭证草稿");
    toast("未生成凭证：请先完成并启用凭证场景", "warning");
    return;
  }
  state.vouchers.unshift(voucher);
  const dimensionIssues = voucher.lines.flatMap((line, lineIndex) =>
    Object.entries(line.dimensionRefs || {})
      .filter(([, reference]) => !["matched", "unverified"].includes(reference?.status))
      .map(([key, reference]) => ({
        lineNo: lineIndex + 1,
        key,
        reference,
      })));
  dimensionIssues.forEach(({ lineNo, key, reference }) => {
    const exceptionId = `EX-MD-${Date.now()}-${lineNo}-${key}`;
    state.exceptions.unshift({
      id: exceptionId,
      eventId: event.id,
      voucherId: voucher.id,
      type: "辅助核算主数据",
      severity: "阻断",
      title: `${event.reference} 第 ${lineNo} 行${reference.label || key}未通过主数据校验`,
      detail: reference.status === "ambiguous"
        ? `“${reference.input}”在目标账套存在多个同名有效编码，系统未自动选择。`
        : reference.status === "unsynced"
          ? `${reference.label || key}主数据尚未从目标账套成功同步。`
          : `目标账套中不存在有效的${reference.label || key}“${reference.input}”。`,
      suggestion: "重新同步主数据，或在凭证场景中改用目标账套的唯一编码。",
      status: "待处理",
    });
    event.exceptionIds ||= [];
    event.exceptionIds.push(exceptionId);
  });
  event.status = voucher.status === "待审核" ? "已生成" : "待处理";
  appendAudit(state, "生成凭证", voucher.number, `应用 ${voucher.ruleVersion}，保留 ${voucher.lines.length} 条分录解释`);
  saveState(state);
  render();
  toast(`已生成可审核的凭证草稿${rule ? `，应用 ${rule.name}` : ""}`);
}

async function batchGenerateVouchers() {
  const pending = state.events.filter((event) =>
    !getVoucherForEvent(event.id)
    && selectPostingRule(state.rules, event)
    && !event.exceptionIds.some((id) => state.exceptions.some((item) => item.id === id && item.status === "待处理")));
  if (!pending.length) return toast("当前没有可批量生成的业务事项", "warning");
  const totalAmount = pending.reduce((sum, event) => sum + (event.amountCents || 0), 0);
  if (!window.confirm(`将为 ${pending.length} 项业务生成凭证草稿，金额合计 ${formatMoney(totalAmount)}。确认继续吗？`)) return;
  const resumable = ["running", "paused"].includes(state.batchGenerationJob?.status);
  const previousCompleted = resumable ? state.batchGenerationJob.completedEventIds || [] : [];
  state.batchGenerationJob = {
    id: resumable ? state.batchGenerationJob.id : `BATCH-GEN-${Date.now()}`,
    status: "running",
    total: previousCompleted.length + pending.length,
    processed: previousCompleted.length,
    percent: 0,
    completedEventIds: previousCompleted,
    startedAt: resumable ? state.batchGenerationJob.startedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveState(state);
  try {
    for (const event of pending) {
      if (getVoucherForEvent(event.id)) continue;
      const { voucher } = buildVoucherForEvent(event);
      state.vouchers.unshift(voucher);
      event.status = voucher.status === "待审核" ? "已生成" : "待处理";
      state.batchGenerationJob.completedEventIds.push(event.id);
      state.batchGenerationJob.processed = state.batchGenerationJob.completedEventIds.length;
      state.batchGenerationJob.percent = Math.round(
        state.batchGenerationJob.processed / state.batchGenerationJob.total * 100,
      );
      state.batchGenerationJob.updatedAt = new Date().toISOString();
      appendAudit(state, "批量生成凭证", voucher.number, `完成事项 ${event.reference}，应用 ${voucher.ruleVersion}`);
      await saveState(state);
      render();
    }
    state.batchGenerationJob.status = "completed";
    state.batchGenerationJob.finishedAt = new Date().toISOString();
    state.batchGenerationJob.percent = 100;
    await saveState(state);
    render();
    toast(`已生成 ${pending.length} 张凭证草稿`);
  } catch (error) {
    state.batchGenerationJob.status = "paused";
    state.batchGenerationJob.lastError = error.message;
    state.batchGenerationJob.updatedAt = new Date().toISOString();
    await saveState(state);
    render();
    toast(`批量生成已暂停：${error.message}`, "warning");
  }
}

function confirmOcrCandidate(exceptionId, card) {
  const exception = state.exceptions.find((item) => item.id === exceptionId);
  const document = exception?.documentIds?.length
    ? state.sourceDocuments.find((item) => item.id === exception.documentIds[0])
    : null;
  if (!exception || !document || exception.status !== "待处理") return;
  const field = (name) => card.querySelector(`[data-ocr-field="${name}"]`)?.value.trim() || "";
  const date = field("date");
  const counterparty = field("counterparty");
  const amount = field("amount");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !counterparty || !amount) {
    toast("请完整核对业务日期、供应商/客商和含税金额", "warning");
    return;
  }
  try {
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error("含税金额必须大于零");
    const reference = field("reference") || field("invoiceNo") || `OCR-${Date.now()}`;
    const event = {
      id: `EV-OCR-${Date.now()}`,
      reference,
      businessKey: `ocr|${document.fullHash || document.hash}|${reference}`,
      type: "",
      company: state.company,
      ledger: state.ledger,
      date,
      counterparty,
      amountCents,
      amountBreakdown: { grossCents: amountCents, netCents: null, taxCents: null, paymentCents: null },
      currency: "CNY",
      department: "",
      project: "",
      summary: counterparty,
      approvalStatus: "unknown",
      sourceVerified: true,
      financeReviewed: false,
      pushAllowed: false,
      matchConfidence: null,
      sourceDocumentIds: [document.id],
      sourceRecords: [{
        documentId: document.id,
        documentType: "OCR 人工确认",
        recordKey: field("invoiceNo") && field("sellerTaxId")
          ? `invoice:${field("sellerTaxId")}:${field("invoiceNo")}`
          : "",
        referenceFields: {
          reference,
          invoiceNo: field("invoiceNo"),
          sellerTaxId: field("sellerTaxId"),
        },
        amountCents,
      }],
      matchExplanation: [
        "OCR 置信度仅用于字段候选，不作为业务事项匹配置信度",
        `候选字段由 ${state.operator} 逐项确认后创建；审批依据和业务类型仍待补充`,
      ],
      exceptionIds: [],
      status: "可生成",
    };
    state.events.unshift(event);
    state.selectedEventId = event.id;
    exception.status = "已解决";
    exception.eventId = event.id;
    exception.resolution = "人工逐项确认 OCR 候选并创建业务事项";
    exception.resolvedBy = state.operator;
    exception.resolvedAt = new Date().toISOString();
    document.extractionStatus = "ocr_confirmed";
    document.ocrConfirmedAt = exception.resolvedAt;
    document.ocrConfirmedBy = state.operator;
    document.confirmedFields = {
      date,
      counterparty,
      amount,
      reference,
      invoiceNo: field("invoiceNo"),
      sellerTaxId: field("sellerTaxId"),
    };
    route = "events";
    window.history.replaceState({}, "", routeHash(route));
    persist(
      "确认 OCR 候选",
      document.name,
      `由 ${state.operator} 确认日期、主体、金额和来源标识，创建事项 ${reference}`,
    );
    toast("OCR 候选已人工确认，业务事项已创建");
  } catch (error) {
    toast(error.message, "warning");
  }
}

function confirmPartialAllocation(exceptionId, card) {
  const exception = state.exceptions.find((item) => item.id === exceptionId);
  const event = state.events.find((item) => item.id === exception?.eventId);
  if (!exception || !event || exception.status !== "待处理") return;
  try {
    const settledCents = toCents(card.querySelector("[data-allocation-amount]")?.value || "");
    const createResidual = card.querySelector("[data-create-residual]")?.checked;
    const sourceAmounts = event.sourceRecords
      ?.map((record) => record.amountCents)
      .filter((amount) => Number.isInteger(amount) && amount > 0) || [];
    const allocationTotalCents = Math.max(event.amountCents, ...sourceAmounts);
    const { settledEvent, residualEvent } = splitEventForPartialPayment(
      event,
      settledCents,
      Date.now(),
      allocationTotalCents,
    );
    Object.assign(event, settledEvent);
    exception.status = "已解决";
    exception.resolution = `人工确认部分付款 ${formatMoney(settledCents)}`;
    exception.resolvedBy = state.operator;
    exception.resolvedAt = new Date().toISOString();
    event.exceptionIds = event.exceptionIds.filter((id) => id !== exception.id);
    event.status = getVoucherForEvent(event.id) ? "待审核" : "可生成";
    if (createResidual) {
      const residualExceptionId = `EX-${Date.now()}`;
      residualEvent.exceptionIds = [residualExceptionId];
      state.events.unshift(residualEvent);
      state.exceptions.unshift({
        id: residualExceptionId,
        eventId: residualEvent.id,
        documentIds: residualEvent.sourceDocumentIds,
        type: "部分付款待匹配",
        severity: "阻断",
        title: `${residualEvent.reference} 等待后续付款资料`,
        detail: `原事项已确认入账 ${formatMoney(settledCents)}，剩余 ${formatMoney(residualEvent.amountCents)} 尚无对应付款资料。`,
        suggestion: "导入后续付款流水并按业务编号关联，或由财务人员确认其他处理方式。",
        status: "待处理",
      });
    }
    state.selectedEventId = event.id;
    route = "events";
    window.history.replaceState({}, "", routeHash(route));
    persist(
      "确认部分付款拆分",
      event.reference,
      `原金额 ${formatMoney(settledEvent.allocationHistory.at(-1).originalCents)}；本次 ${formatMoney(settledCents)}；剩余 ${formatMoney(residualEvent.amountCents)}${createResidual ? " 已创建待匹配事项" : " 未创建事项"}`,
    );
    toast("金额差异已按人工确认结果拆分");
  } catch (error) {
    toast(error.message, "warning");
  }
}

function saveVoucherEdits(voucherId) {
  const voucher = state.vouchers.find((item) => item.id === voucherId);
  if (!voucher || !["待审核", "待处理", "已确认"].includes(voucher.status)) return;
  try {
    const reason = document.querySelector("[data-edit-reason]")?.value.trim() || "";
    const saveAsRule = document.querySelector("[data-save-as-rule]")?.checked;
    const nextLines = [...document.querySelectorAll("[data-edit-line]")].map((row, index) => {
      const field = (name) => row.querySelector(`[data-line-field="${name}"]`)?.value.trim() || "";
      const dimensions = document.querySelector(`[data-edit-dimensions="${index}"]`);
      const editedDimensions = Object.fromEntries(
        [...(dimensions?.querySelectorAll("[data-dimension-field]") || [])]
          .map((input) => [input.dataset.dimensionField, input.value.trim() || null]),
      );
      return {
        ...voucher.lines[index],
        lineNo: index + 1,
        summary: field("summary"),
        accountCode: field("accountCode"),
        accountName: field("accountName"),
        debitCents: toCents(field("debit") || "0"),
        creditCents: toCents(field("credit") || "0"),
        dimensions: editedDimensions,
        dimensionRefs: {},
        explanation: `由 ${state.operator} 人工编辑并重新校验`,
      };
    });
    const updated = applyVoucherLineEdits(voucher, nextLines, state.operator, reason);
    Object.assign(voucher, updated);
    if (saveAsRule) {
      const event = state.events.find((item) => voucher.sourceEventIds.includes(item.id));
      const ruleId = `RULE-${Date.now()}`;
      const generatedRule = createRuleFromVoucherEdit(voucher, event, state.operator, ruleId);
      state.rules.unshift(generatedRule);
      appendAudit(
        state,
        "创建规则",
        generatedRule.name,
        `由凭证 ${voucher.number} 的人工修改生成完整结构化规则 v1.0，保持待启用`,
      );
    }
    editingVoucherId = null;
    persist("编辑凭证", voucher.number, `${state.operator} 修改分录并重新校验；原因：${reason}`);
    toast("分录已保存并重新校验");
  } catch (error) {
    toast(error.message, "warning");
  }
}

function batchApproveVouchers() {
  const eligible = eligibleForBatchConfirmation(state);
  if (!eligible.length) return toast("当前没有可批量确认的凭证", "warning");
  const total = eligible.reduce((sum, voucher) => sum + validateVoucher(voucher).debitCents, 0);
  if (!window.confirm(`将确认 ${eligible.length} 张凭证，借方合计 ${formatMoney(total)}。确认继续吗？`)) return;
  eligible.forEach((voucher) => {
    voucher.status = "已确认";
    voucher.financeReviewed = true;
    voucher.pushAllowed = false;
    voucher.operator = state.operator;
    voucher.confirmedAt = new Date().toISOString();
    voucher.sourceEventIds.forEach((eventId) => {
      const event = state.events.find((item) => item.id === eventId);
      if (event) event.status = "已完成";
    });
  });
  persist("批量确认凭证", `${eligible.length} 张凭证`, `借方合计 ${formatMoney(total)}，由 ${state.operator} 人工确认`);
  toast(`已确认 ${eligible.length} 张凭证`);
}

function approveVoucher(voucherId) {
  const voucher = state.vouchers.find((item) => item.id === voucherId);
  if (!voucher) return;
  const validation = validateVoucher(voucher);
  const event = state.events.find((item) => voucher.sourceEventIds.includes(item.id));
  const blocked = event?.exceptionIds.some((id) =>
    state.exceptions.some((exception) => exception.id === id && exception.status === "待处理"));
  if (!validation.valid || blocked) {
    toast("凭证存在阻断问题，暂时不能确认", "warning");
    return;
  }
  voucher.status = "已确认";
  voucher.financeReviewed = true;
  voucher.pushAllowed = false;
  voucher.operator = state.operator;
  event.status = "已完成";
  persist("确认凭证", voucher.number, `借贷平衡，由 ${state.operator} 人工确认`);
  toast("财务复核已完成；允许推送仍需单独确认");
}

async function pushVoucher(voucherId) {
  const voucher = state.vouchers.find((item) => item.id === voucherId);
  if (!voucher || voucher.status !== "已确认") return;
  if (!voucher.financeReviewed || !voucher.pushAllowed) {
    return toast("请先完成财务复核并单独允许推送", "warning");
  }
  const connectorId = state.activeFinanceConnectorId;
  const connector = state.connectors.find((item) => item.id === connectorId);
  if (!connector) return toast("未找到当前财务连接器", "warning");
  if (connector.environment === "生产环境") {
    const confirmation = window.prompt("这是生产环境推送。请输入“生产环境”继续：", "");
    if (confirmation !== "生产环境") return toast("已取消生产环境推送", "warning");
  }
  try {
    const preflight = await preflightVoucher(voucherId, connectorId, connector.environment);
    const failed = preflight.report.checks.filter((item) => item.status !== "passed");
    if (failed.length) {
      return toast(
        `推送前校验未通过：${failed.map((item) => `${item.name}（${item.detail}）`).join("；")}`,
        "warning",
      );
    }
    const summary = preflight.report.checks.map((item) => `✓ ${item.name}`).join("\n");
    if (!window.confirm(`推送前检查全部通过：\n${summary}\n\n仅保存凭证草稿，确认继续吗？`)) return;
    voucher.status = "推送中";
    render();
    toast("正在保存草稿并按幂等键回查");
    const result = await pushVoucherToConnector(voucherId, connectorId, connector.environment);
    state = result.state;
    render();
    toast(result.message, result.voucher.status === "已推送" ? "success" : "warning");
  } catch (error) {
    state = (await loadState());
    render();
    toast(error.message, "warning");
  }
}

async function saveConnectorConfiguration(connectorId) {
  const form = document.querySelector(`[data-connector-form="${connectorId}"]`);
  if (!form?.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  const secret = String(values.secret || "");
  delete values.secret;
  let config;
  let secretName;
  const connector = state.connectors.find((item) => item.id === connectorId);
  if (!connector) return toast("连接器不存在", "warning");
  if (connector.adapter === "kingdee-k3cloud-webapi-v6") {
    config = {
      authMode: "app-id-secret-v3",
      serverUrl: submittedConfigValue(values.serverUrl, connector.serverUrl).replace(/\/+$/, ""),
      acctId: submittedConfigValue(values.acctId, connector.acctId),
      username: submittedConfigValue(values.username, connector.username),
      appId: submittedConfigValue(values.appId, connector.appId),
      orgNum: submittedConfigValue(values.orgNum, connector.orgNum),
      ledger: submittedConfigValue(values.ledger, connector.ledger),
      voucherFormId: connector.voucherFormId || "GL_VOUCHER",
      voucherGroup: connector.voucherGroup || "PZZ47",
      currencyCode: connector.currencyCode || "PRE001",
      exchangeRateType: connector.exchangeRateType || "001",
      localeId: Number(connector.localeId || 2052),
      connectTimeout: Number(connector.connectTimeout || 120),
      requestTimeout: Number(connector.requestTimeout || 120),
      approvalControlEnabled: connector.approvalControlEnabled !== false,
      enforceTargetMasterData: connector.enforceTargetMasterData !== false,
      enforcePeriodQuery: connector.enforcePeriodQuery !== false,
      periodQuery: connector.periodQuery || {},
      readModels: connector.readModels || {},
      masterDataQueries: connector.masterDataQueries || [],
      dimensionFieldMap: connector.dimensionFieldMap || {},
      environment: connector.environment,
      leastPrivilegeConfirmed: connector.leastPrivilegeConfirmed === true,
    };
    secretName = "app_secret";
  } else if (connector.adapter === "feishu-approval-v4" || connector.adapter === "oa-json-api") {
    config = {
      environment: connector.environment,
      leastPrivilegeConfirmed: connector.leastPrivilegeConfirmed === true,
      fieldMapping: connector.fieldMapping || {},
    };
    if (connector.adapter === "feishu-approval-v4") {
      config.platform = submittedConfigValue(values.platform, connector.platform);
      config.appId = submittedConfigValue(values.appId, connector.appId);
      secretName = "app_secret";
    } else {
      Object.assign(config, {
        providerName: String(connector.providerName || connector.name || "").trim(),
        baseUrl: submittedConfigValue(values.baseUrl, connector.baseUrl).replace(/\/+$/, ""),
        authHeader: String(connector.authHeader || "Authorization").trim(),
        authScheme: String(connector.authScheme ?? "Bearer").trim(),
        recordsPath: String(connector.recordsPath || "data.items").trim(),
        externalIdPath: String(connector.externalIdPath || "id").trim(),
        approvalStatusPath: String(connector.approvalStatusPath || "status").trim(),
        approvedValues: connector.approvedValues || ["APPROVED", "approved", "已通过"],
      });
      secretName = "access_token";
    }
  } else {
    config = {
      baseUrl: submittedConfigValue(values.baseUrl, connector.baseUrl).replace(/\/+$/, ""),
      accountId: String(connector.accountId || "").trim(),
      username: submittedConfigValue(values.username, connector.username),
      ledger: String(connector.ledger || "").trim(),
      environment: connector.environment,
      leastPrivilegeConfirmed: connector.leastPrivilegeConfirmed === true,
    };
    config.dimensionFieldMap = connector.dimensionFieldMap || {};
    if (connector.adapter !== "kingdee-k3cloud-webapi-v6") {
      config.endpointProfile = connector.endpointProfile || {};
      config.fieldProfile = connector.fieldProfile || {};
    }
    secretName = "access_token";
  }
  let productionConfirmation = "";
  if (config.environment === "生产环境") {
    productionConfirmation = window.prompt("切换生产环境需要输入“生产环境”：", "") || "";
    if (productionConfirmation !== "生产环境") return toast("未保存：生产环境确认不完整", "warning");
  }
  try {
    if (secret) await saveConnectorSecret(connectorId, secretName, secret);
    const result = await configureConnector(connectorId, config, productionConfirmation);
    state = result.state;
    render();
    toast("连接器配置已保存；密钥未写入业务数据库");
    return result;
  } catch (error) {
    toast(error.message, "warning");
    return null;
  }
}

function approvalDataConfigurationPayload(form, connector, additionalApprovalFieldIds = null) {
  const formData = new FormData(form);
  const profileId = String(formData.get("profileId") || "").trim();
  const profile = approvalProfileForConnector(connector, profileId) || {
    approvalFields: [],
    additionalApprovalFieldIds: [],
  };
  const fieldMapping = Object.fromEntries(
    [...form.querySelectorAll("[data-feishu-mapping]")]
      .map((element) => [element.dataset.feishuMapping, String(element.value || "").trim()])
      .filter(([, value]) => value && !value.startsWith("source:")),
  );
  const knownFieldIds = new Set(
    (profile.approvalFields || []).map((field) => String(field.id)),
  );
  const mappedFieldIds = new Set(Object.values(fieldMapping));
  const selectedAdditionalFieldIds = additionalApprovalFieldIds
    ?? profile.additionalApprovalFieldIds
    ?? [];
  return {
    profileId,
    approvalCode: String(formData.get("approvalCode") || "").trim(),
    queryDateFrom: String(formData.get("queryDateFrom") || "").trim(),
    queryDateTo: String(formData.get("queryDateTo") || "").trim(),
    fieldMapping,
    fieldSources: [],
    additionalApprovalFieldIds: [...new Set(
      selectedAdditionalFieldIds
        .map((fieldId) => String(fieldId))
        .filter((fieldId) => knownFieldIds.has(fieldId) && !mappedFieldIds.has(fieldId)),
    )],
  };
}

async function persistApprovalDataConfiguration(
  connectorId,
  {
    validation = "all",
    additionalApprovalFieldIds = null,
    successMessage = "审批查询参数与字段映射已保存",
  } = {},
) {
  const form = document.querySelector(`[data-approval-config-form="${connectorId}"]`);
  if (!form) return null;
  if (validation === "all" && !form.reportValidity()) return null;
  if (validation === "query") {
    const queryFields = ["approvalCode", "queryDateFrom", "queryDateTo"]
      .map((name) => form.elements.namedItem(name))
      .filter(Boolean);
    const invalidField = queryFields.find((field) => !field.checkValidity());
    if (invalidField) {
      invalidField.reportValidity();
      return null;
    }
  }
  const connector = state.connectors.find((item) => item.id === connectorId);
  if (!connector || connector.adapter !== "feishu-approval-v4") {
    toast("飞书审批连接器不存在", "warning");
    return null;
  }
  const config = approvalDataConfigurationPayload(form, connector, additionalApprovalFieldIds);
  if (config.queryDateFrom > config.queryDateTo) {
    toast("审批记录完成日期的开始日期不能晚于结束日期", "warning");
    return null;
  }
  try {
    const result = await configureConnectorApprovalQuery(connectorId, config);
    state = result.state;
    selectedApprovalProfileId = String(result.profile?.id || selectedApprovalProfileId || "");
    render();
    if (successMessage) toast(successMessage);
    return result;
  } catch (error) {
    toast(error.message, "warning");
    return null;
  }
}

async function saveApprovalDataConfiguration(connectorId) {
  return persistApprovalDataConfiguration(connectorId);
}

async function addApprovalAdditionalField(connectorId) {
  const form = document.querySelector(`[data-approval-config-form="${connectorId}"]`);
  const connector = state.connectors.find((item) => item.id === connectorId);
  if (!form || !connector) return null;
  const profileId = String(new FormData(form).get("profileId") || "");
  const profile = approvalProfileForConnector(connector, profileId);
  if (!profile) return null;
  const fieldSelect = form.querySelector("[data-approval-additional-field]");
  const fieldId = String(fieldSelect?.value || "");
  const field = (profile.approvalFields || [])
    .find((item) => String(item.id) === fieldId);
  if (!field) {
    toast("请选择当前审批模板中的字段", "warning");
    return null;
  }
  if ((profile.additionalApprovalFieldIds || []).map(String).includes(fieldId)) {
    toast("这个审批字段已经添加", "warning");
    return null;
  }
  approvalWorkspacePanel = "mapping";
  return persistApprovalDataConfiguration(connectorId, {
    validation: "none",
    additionalApprovalFieldIds: [
      ...(profile.additionalApprovalFieldIds || []),
      fieldId,
    ],
    successMessage: `已添加审批字段 ${field.name}`,
  });
}

async function removeApprovalAdditionalField(connectorId, fieldId) {
  const connector = state.connectors.find((item) => item.id === connectorId);
  const form = document.querySelector(`[data-approval-config-form="${connectorId}"]`);
  if (!connector || !form) return null;
  const profileId = String(new FormData(form).get("profileId") || "");
  const profile = approvalProfileForConnector(connector, profileId);
  const field = (profile?.approvalFields || [])
    .find((item) => String(item.id) === String(fieldId));
  if (!profile || !field) return null;
  approvalWorkspacePanel = "mapping";
  return persistApprovalDataConfiguration(connectorId, {
    validation: "none",
    additionalApprovalFieldIds: (profile.additionalApprovalFieldIds || [])
      .filter((item) => String(item) !== String(fieldId)),
    successMessage: `已移除审批字段 ${field.name}`,
  });
}

async function readFeishuApprovalFields(connectorId) {
  const saved = await persistApprovalDataConfiguration(connectorId, {
    validation: "query",
    successMessage: "",
  });
  if (!saved) return;
  try {
    toast("正在从飞书读取审批模板和字段定义");
    const result = await readConnectorApprovalFields(
      connectorId,
      String(saved.profile?.id || selectedApprovalProfileId || ""),
    );
    state = result.state;
    selectedApprovalProfileId = String(result.profile?.id || selectedApprovalProfileId || "");
    render();
    const fieldCount = result.approval?.fields?.length || 0;
    toast(
      fieldCount
        ? `已读取 ${fieldCount} 个审批字段，请核对字段映射`
        : "审批模板读取成功，但没有解析到可映射字段",
      fieldCount ? "success" : "warning",
    );
  } catch (error) {
    state = await loadState();
    render();
    toast(error.message, "warning");
  }
}

async function runConnectorOperation(connectorId, operation) {
  try {
    toast(operation === "test" ? "正在检查身份、范围与能力" : "正在同步目标数据");
    const result = operation === "test"
      ? await testConnector(connectorId)
      : operation === "approvals"
        ? await syncConnectorApprovals(connectorId, (job) => {
          connectorJob = job;
          render();
        })
        : await syncConnectorMasterData(connectorId, (job) => {
          connectorJob = job;
          render();
        });
    connectorJob = null;
    state = result.state;
    render();
    if (operation === "test") {
      toast(result.report.ok ? "连接测试通过，目标环境已锁定" : "连接测试未通过", result.report.ok ? "success" : "warning");
    } else if (operation === "approvals") {
      toast(`同步完成：新增 ${result.sync.created}，跳过或更新 ${result.sync.skipped}`);
    } else {
      toast(`基础资料同步完成：新增或更新 ${result.created} 条`);
    }
  } catch (error) {
    connectorJob = null;
    state = await loadState();
    render();
    toast(error.message, "warning");
  }
}

async function exportVoucher(voucherId) {
  const voucher = state.vouchers.find((item) => item.id === voucherId);
  if (!voucher || !["已确认", "已推送"].includes(voucher.status)) return;
  try {
    const response = await fetch(`/api/vouchers/${encodeURIComponent(voucherId)}/export.xlsx`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "凭证导出失败");
    }
    const exportHash = response.headers.get("X-Content-SHA256") || "未取得";
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `通用凭证_${voucher.number}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
    appendAudit(
      state,
      "导出凭证",
      voucher.number,
      `模板：通用凭证 XLSX v1；文件 SHA-256 ${exportHash}；包含凭证头、分录和辅助核算`,
    );
    saveState(state);
    render();
    toast("凭证 XLSX 已导出并记录审计日志");
  } catch (error) {
    toast(error.message, "warning");
  }
}

function downloadBlob(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function applyWorkflowCanvasView(
  surface = document.querySelector("[data-workflow-canvas]"),
  viewport = document.querySelector("[data-workflow-canvas-viewport]"),
) {
  if (!surface || !viewport) return;
  surface.style.transform = `translate(${workflowCanvasView.x}px, ${workflowCanvasView.y}px) scale(${workflowCanvasView.zoom})`;
  const label = document.querySelector("[data-canvas-zoom-label]");
  if (label) label.textContent = `${Math.round(workflowCanvasView.zoom * 100)}%`;
  const minimapViewport = document.querySelector(".workflow-minimap-viewport");
  if (minimapViewport) {
    const width = Math.min(100, (viewport.clientWidth / (surface.clientWidth * workflowCanvasView.zoom)) * 100);
    const height = Math.min(100, (viewport.clientHeight / (surface.clientHeight * workflowCanvasView.zoom)) * 100);
    const left = Math.max(0, Math.min(100 - width, (-workflowCanvasView.x / (surface.clientWidth * workflowCanvasView.zoom)) * 100));
    const top = Math.max(0, Math.min(100 - height, (-workflowCanvasView.y / (surface.clientHeight * workflowCanvasView.zoom)) * 100));
    minimapViewport.style.cssText = `left:${left}%;top:${top}%;width:${width}%;height:${height}%`;
  }
}

function setWorkflowCanvasZoom(nextZoom, viewport, surface) {
  const previousZoom = workflowCanvasView.zoom;
  const zoom = Math.min(1.65, Math.max(0.55, Number(nextZoom) || 1));
  if (Math.abs(zoom - previousZoom) < 0.001) return;
  workflowCanvasView = {
    x: 0,
    y: 0,
    zoom,
  };
  applyWorkflowCanvasView(surface, viewport);
  saveWorkflowCanvasView();
}

function updateWorkflowCanvasEdges(surface = document.querySelector("[data-workflow-canvas]")) {
  if (!surface) return;
  surface.querySelectorAll("[data-edge-from][data-edge-to]").forEach((path) => {
    const from = surface.querySelector(`[data-canvas-node="${CSS.escape(path.dataset.edgeFrom)}"]`);
    const to = surface.querySelector(`[data-canvas-node="${CSS.escape(path.dataset.edgeTo)}"]`);
    if (!from || !to) return;
    const startX = from.offsetLeft + from.offsetWidth;
    const startY = from.offsetTop + (from.offsetHeight / 2);
    const endX = to.offsetLeft;
    const endY = to.offsetTop + (to.offsetHeight / 2);
    const route = workflowCanvasEdgeRoutes[workflowCanvasEdgeKey(path.dataset.edgeFrom, path.dataset.edgeTo)];
    const middleX = resolveWorkflowCanvasEdgeMiddleX({
      startX,
      endX,
      surfaceWidth: surface.clientWidth,
      storedNormalizedX: route?.x,
    });
    path.dataset.edgeMiddleX = middleX.toFixed(3);
    path.setAttribute(
      "d",
      `M ${startX.toFixed(1)} ${startY.toFixed(1)} H ${middleX.toFixed(1)} V ${endY.toFixed(1)} H ${endX.toFixed(1)}`,
    );
  });
}

function attachWorkflowCanvas() {
  const surface = document.querySelector("[data-workflow-canvas]");
  const viewport = document.querySelector("[data-workflow-canvas-viewport]");
  if (!surface || !viewport) return;
  workflowCanvasView.x = 0;
  workflowCanvasView.y = 0;
  saveWorkflowCanvasView();
  const canvasMain = viewport.closest(".workflow-canvas-main");
  canvasMain?.addEventListener("pointerdown", (event) => {
    if (!activeWorkflowNode) return;
    if (event.target.closest("[data-canvas-node], .workflow-canvas-edge-hit")) return;
    event.preventDefault();
    event.stopPropagation();
    activeWorkflowNode = null;
    render();
  }, { capture: true });
  const canvasNodes = [...surface.querySelectorAll("[data-canvas-node]")];
  requestAnimationFrame(() => {
    let correctedStoredPosition = false;
    canvasNodes.forEach((node) => {
      const left = clampWorkflowCanvasNodeLeft({
        nodeId: node.dataset.canvasNode,
        laneKind: node.dataset.workflowLane,
        desiredLeft: node.offsetLeft,
        surfaceWidth: surface.clientWidth,
        nodeWidth: node.offsetWidth,
      });
      if (Math.abs(left - node.offsetLeft) < 0.5) return;
      node.style.left = `${left}px`;
      workflowCanvasPositions[node.dataset.canvasNode] = {
        x: left / surface.clientWidth,
        y: node.offsetTop / surface.clientHeight,
      };
      const minimapNode = document.querySelector(`[data-minimap-node="${CSS.escape(node.dataset.canvasNode)}"]`);
      if (minimapNode) minimapNode.style.left = `${(left / surface.clientWidth) * 100}%`;
      correctedStoredPosition = true;
    });
    if (correctedStoredPosition) saveWorkflowCanvasPositions();
    applyWorkflowCanvasView(surface, viewport);
    updateWorkflowCanvasEdges(surface);
  });

  canvasNodes.forEach((node) => {
    let dragState = null;
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      dragState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLeft: node.offsetLeft,
        startTop: node.offsetTop,
        moved: false,
      };
      try {
        node.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic accessibility and test events can move nodes without pointer capture.
      }
      node.classList.add("dragging");
      node.focus({ preventScroll: true });
    });
    node.addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const pointerDeltaX = event.clientX - dragState.startClientX;
      const pointerDeltaY = event.clientY - dragState.startClientY;
      const deltaX = pointerDeltaX / workflowCanvasView.zoom;
      const deltaY = pointerDeltaY / workflowCanvasView.zoom;
      if (!dragState.moved && Math.hypot(deltaX, deltaY) < 4) return;
      dragState.moved = true;
      event.preventDefault();
      const left = clampWorkflowCanvasNodeLeft({
        nodeId: node.dataset.canvasNode,
        laneKind: node.dataset.workflowLane,
        desiredLeft: dragState.startLeft + deltaX,
        surfaceWidth: surface.clientWidth,
        nodeWidth: node.offsetWidth,
      });
      const top = Math.min(
        surface.clientHeight - node.offsetHeight - 12,
        Math.max(96, dragState.startTop + deltaY),
      );
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      workflowCanvasPositions[node.dataset.canvasNode] = {
        x: left / surface.clientWidth,
        y: top / surface.clientHeight,
      };
      const minimapNode = document.querySelector(`[data-minimap-node="${CSS.escape(node.dataset.canvasNode)}"]`);
      if (minimapNode) {
        minimapNode.style.left = `${(left / surface.clientWidth) * 100}%`;
        minimapNode.style.top = `${(top / surface.clientHeight) * 100}%`;
      }
      updateWorkflowCanvasEdges(surface);
    });
    const finishDrag = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      node.classList.remove("dragging");
      if (dragState.moved) {
        const left = clampWorkflowCanvasNodeLeft({
          nodeId: node.dataset.canvasNode,
          laneKind: node.dataset.workflowLane,
          desiredLeft: node.offsetLeft,
          surfaceWidth: surface.clientWidth,
          nodeWidth: node.offsetWidth,
        });
        node.style.left = `${left}px`;
        workflowCanvasPositions[node.dataset.canvasNode] = {
          x: left / surface.clientWidth,
          y: node.offsetTop / surface.clientHeight,
        };
        const minimapNode = document.querySelector(`[data-minimap-node="${CSS.escape(node.dataset.canvasNode)}"]`);
        if (minimapNode) minimapNode.style.left = `${(left / surface.clientWidth) * 100}%`;
        node.dataset.suppressClick = "true";
        saveWorkflowCanvasPositions();
        updateWorkflowCanvasEdges(surface);
      }
      dragState = null;
    };
    node.addEventListener("pointerup", finishDrag);
    node.addEventListener("pointercancel", finishDrag);
    node.addEventListener("click", (event) => {
      if (node.dataset.suppressClick) {
        delete node.dataset.suppressClick;
        event.preventDefault();
        return;
      }
      activeWorkflowNode = activeWorkflowNode === node.dataset.workflowNode
        ? null
        : node.dataset.workflowNode;
      render();
    });
  });

  let edgeDragState = null;
  viewport.addEventListener("pointerdown", (event) => {
    const edge = event.target.closest(".workflow-canvas-edge-hit");
    if (!edge || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    edgeDragState = {
      edge,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startMiddleX: Number(edge.dataset.edgeMiddleX) || (surface.clientWidth / 2),
      moved: false,
    };
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic accessibility and test events can move edges without pointer capture.
    }
    edge.classList.add("dragging");
    viewport.classList.add("dragging-edge");
  }, { capture: true });
  viewport.addEventListener("pointermove", (event) => {
    if (!edgeDragState || edgeDragState.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const deltaX = (event.clientX - edgeDragState.startClientX) / workflowCanvasView.zoom;
    if (!edgeDragState.moved && Math.abs(deltaX) < 3) return;
    edgeDragState.moved = true;
    const key = workflowCanvasEdgeKey(
      edgeDragState.edge.dataset.edgeFrom,
      edgeDragState.edge.dataset.edgeTo,
    );
    workflowCanvasEdgeRoutes[key] = {
      x: normalizeWorkflowCanvasEdgeX(edgeDragState.startMiddleX + deltaX, surface.clientWidth),
    };
    updateWorkflowCanvasEdges(surface);
  }, { capture: true });
  const finishEdgeDrag = (event) => {
    if (!edgeDragState || edgeDragState.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    edgeDragState.edge.classList.remove("dragging");
    viewport.classList.remove("dragging-edge");
    if (edgeDragState.moved) saveWorkflowCanvasEdgeRoutes();
    edgeDragState = null;
  };
  viewport.addEventListener("pointerup", finishEdgeDrag, { capture: true });
  viewport.addEventListener("pointercancel", finishEdgeDrag, { capture: true });

  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (!event.ctrlKey && !event.metaKey) return;
    const factor = Math.exp(-event.deltaY * 0.002);
    setWorkflowCanvasZoom(workflowCanvasView.zoom * factor, viewport, surface);
  }, { passive: false });

  document.querySelector("[data-canvas-zoom-out]")?.addEventListener("click", () => {
    setWorkflowCanvasZoom(workflowCanvasView.zoom - 0.1, viewport, surface);
  });
  document.querySelector("[data-canvas-zoom-in]")?.addEventListener("click", () => {
    setWorkflowCanvasZoom(workflowCanvasView.zoom + 0.1, viewport, surface);
  });
  document.querySelector("[data-minimap-zoom-out]")?.addEventListener("click", () => {
    setWorkflowCanvasZoom(workflowCanvasView.zoom - 0.1, viewport, surface);
  });
  document.querySelector("[data-minimap-zoom-in]")?.addEventListener("click", () => {
    setWorkflowCanvasZoom(workflowCanvasView.zoom + 0.1, viewport, surface);
  });
  document.querySelector("[data-canvas-zoom-reset]")?.addEventListener("click", () => {
    workflowCanvasView = { x: 0, y: 0, zoom: 1 };
    applyWorkflowCanvasView(surface, viewport);
    saveWorkflowCanvasView();
  });
  document.querySelector("[data-canvas-fit]")?.addEventListener("click", () => {
    workflowCanvasView = { x: 0, y: 0, zoom: 1 };
    applyWorkflowCanvasView(surface, viewport);
    saveWorkflowCanvasView();
  });
  document.querySelector("[data-canvas-history-back]")?.addEventListener("click", () => window.history.back());
  document.querySelector("[data-canvas-history-forward]")?.addEventListener("click", () => window.history.forward());
  document.querySelector("[data-workflow-canvas-search]")?.addEventListener("input", (event) => {
    const needle = event.currentTarget.value.trim().toLocaleLowerCase();
    surface.querySelectorAll("[data-canvas-node]").forEach((node) => {
      const matches = !needle || node.textContent.toLocaleLowerCase().includes(needle);
      node.classList.toggle("search-dimmed", Boolean(needle) && !matches);
      node.classList.toggle("search-match", Boolean(needle) && matches);
    });
  });

  document.querySelector("[data-reset-workflow-canvas]")?.addEventListener("click", () => {
    workflowCanvasPositions = defaultWorkflowCanvasPositions();
    workflowCanvasView = { x: 0, y: 0, zoom: 1 };
    workflowCanvasEdgeRoutes = {};
    localStorage.removeItem(WORKFLOW_CANVAS_STORAGE_KEY);
    localStorage.removeItem(WORKFLOW_CANVAS_VIEW_STORAGE_KEY);
    localStorage.removeItem(WORKFLOW_CANVAS_EDGE_STORAGE_KEY);
    activeWorkflowNode = null;
    render();
    toast("画布、轨道与缩放已恢复默认");
  });
  document.querySelector("[data-close-workflow-inspector]")?.addEventListener("click", () => {
    activeWorkflowNode = null;
    render();
  });
}

function readRuleLineSpec(row, key) {
  const mode = row.querySelector(`[data-rule-line-spec-mode="${key}"]`)?.value || "fixed";
  return ruleSpec(
    mode,
    row.querySelector(`[data-rule-line-spec-value="${key}"]`)?.value.trim() || "",
    row.querySelector(`[data-rule-line-spec-field="${key}"]`)?.value || "",
    row.querySelector(`[data-rule-line-spec-calculation="${key}"]`)?.value || "",
  );
}

function captureRuleEditorDraft() {
  if (!ruleEditorDraft || !ruleEditorOpen) return ruleEditorDraft;
  ruleEditorDraft.name = document.querySelector("[data-rule-name]")?.value.trim() || "";
  ruleEditorDraft.priority = Number(document.querySelector("[data-rule-priority]")?.value || 0);
  ruleEditorDraft.match = {
    businessType: document.querySelector("[data-rule-business-type]")?.value.trim() || "",
    counterparty: document.querySelector("[data-rule-counterparty]")?.value.trim() || "",
  };
  ruleEditorDraft.posting ||= {};
  ruleEditorDraft.posting.lines = ruleEditorDraft.posting.lines.map((existingLine, index) => {
    const config = document.querySelector(`[data-rule-line-config="${index}"]`);
    if (!config) return normalizeRulePostingLine(existingLine, index === 0 ? "debit" : "credit");
    const dimensionBindings = [...config.querySelectorAll("[data-rule-dimension-binding]")]
      .map((bindingRow) => {
        const key = bindingRow.querySelector("[data-rule-dimension-key]")?.value || "";
        return {
          key,
          required: bindingRow.querySelector("[data-rule-dimension-required]")?.checked === true,
          valueSpec: readRuleLineSpec(bindingRow, `dimension.${key}`),
        };
      })
      .filter((binding) => binding.key);
    const requiredDimensions = dimensionBindings
      .filter((binding) => binding.required)
      .map((binding) => binding.key);
    const accountSourceMode = config.querySelector("[data-rule-line-account-source]")?.value
      || existingLine.accountSource?.mode
      || "fixed";
    return {
      summaryTemplate: config.querySelector("[data-rule-line-summary]")?.value.trim() || "",
      accountCode: accountSourceMode === "field"
        ? ""
        : config.querySelector("[data-rule-line-account-code]")?.value.trim() || "",
      accountName: accountSourceMode === "field"
        ? ""
        : config.querySelector("[data-rule-line-account-name]")?.value.trim() || "",
      accountSource: {
        mode: accountSourceMode === "field" ? "field" : "fixed",
        field: accountSourceMode === "field"
          ? config.querySelector("[data-rule-line-account-field]")?.value || "debitAccount"
          : "",
      },
      dimensions: Object.fromEntries(
        dimensionBindings.map((binding) => [binding.key, binding.valueSpec]),
      ),
      dimensionBindings,
      requiredDimensions,
      currency: readRuleLineSpec(config, "currency"),
      exchangeRateType: readRuleLineSpec(config, "exchangeRateType"),
      exchangeRate: readRuleLineSpec(config, "exchangeRate"),
      originalAmount: readRuleLineSpec(config, "originalAmount"),
      debitAmount: readRuleLineSpec(config, "debitAmount"),
      creditAmount: readRuleLineSpec(config, "creditAmount"),
    };
  });
  return ruleEditorDraft;
}

function ruleAmountSpecActive(spec) {
  if (!spec) return false;
  if (spec.mode === "fixed") {
    try {
      return toCents(spec.value || "0") !== 0;
    } catch {
      return false;
    }
  }
  return Boolean(spec.field || spec.calculation);
}

function attachEvents() {
  document.querySelector("[data-reload-app]")?.addEventListener("click", () => window.location.reload());
  document.querySelector("[data-open-runtime-status]")?.addEventListener("click", () => {
    runtimeStatusOpen = true;
    render();
    document.querySelector("[data-close-runtime-status]")?.focus();
  });
  document.querySelector("[data-close-runtime-status]")?.addEventListener("click", () => {
    runtimeStatusOpen = false;
    render();
    document.querySelector("[data-open-runtime-status]")?.focus();
  });
  document.querySelector("[data-runtime-status-layer]")?.addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    runtimeStatusOpen = false;
    render();
    document.querySelector("[data-open-runtime-status]")?.focus();
  });
  if (runtimeStatusKeyHandler) document.removeEventListener("keydown", runtimeStatusKeyHandler);
  runtimeStatusKeyHandler = (event) => {
    if (event.key !== "Escape" || !runtimeStatusOpen) return;
    runtimeStatusOpen = false;
    render();
    document.querySelector("[data-open-runtime-status]")?.focus();
  };
  document.addEventListener("keydown", runtimeStatusKeyHandler);
  attachWorkflowCanvas();
  document.querySelectorAll("[data-route]").forEach((element) => {
    element.addEventListener("click", () => navigate(element.dataset.route));
  });
  document.querySelector("[data-validate-workflow]")?.addEventListener("click", () => {
    const pending = state.exceptions.filter((item) => item.status === "待处理");
    const blocking = pending.filter((item) => ["阻断", "blocking"].includes(item.severity)).length;
    const warnings = pending.length - blocking;
    if (blocking) {
      toast(`流程校验发现 ${blocking} 个阻断错误，请先处理`, "warning");
      return;
    }
    if (warnings) {
      toast(`流程可继续，仍有 ${warnings} 个事项待确认`, "warning");
      return;
    }
    toast("流程校验通过，节点和连接均可用");
  });
  document.querySelectorAll("[data-systems-panel]").forEach((element) => {
    element.addEventListener("click", () => {
      systemsPanelId = element.dataset.systemsPanel;
      editingMasterDataId = null;
      render();
    });
  });
  document.querySelector("[data-master-filter-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    masterDataFilters = {
      category: masterDataFilters.category,
      source: String(values.source || "all"),
      status: String(values.status || "active"),
      search: String(values.search || "").trim(),
    };
    masterDataPage = 0;
    editingMasterDataId = null;
    render();
  });
  document.querySelectorAll("[data-master-category]").forEach((element) => {
    element.addEventListener("click", () => {
      masterDataFilters.category = element.dataset.masterCategory || "all";
      masterDataPage = 0;
      editingMasterDataId = null;
      render();
    });
  });
  document.querySelector("[data-clear-master-filters]")?.addEventListener("click", () => {
    masterDataFilters = {
      category: "all",
      source: "all",
      status: "active",
      search: "",
    };
    masterDataPage = 0;
    editingMasterDataId = null;
    render();
  });
  document.querySelectorAll("[data-master-page]").forEach((element) => {
    element.addEventListener("click", () => {
      const nextPage = Number(element.dataset.masterPage);
      if (!Number.isInteger(nextPage) || nextPage < 0) return;
      masterDataPage = nextPage;
      editingMasterDataId = null;
      render();
      document.querySelector(".master-data-filterbar")?.scrollIntoView({ block: "start" });
    });
  });
  document.querySelectorAll("[data-edit-master]").forEach((element) => {
    element.addEventListener("click", () => {
      editingMasterDataId = element.dataset.editMaster;
      render();
      document.querySelector(`[data-account-row="${CSS.escape(editingMasterDataId)}"] input`)?.focus();
    });
  });
  document.querySelector("[data-cancel-master-edit]")?.addEventListener("click", () => {
    editingMasterDataId = null;
    render();
  });
  const sourceMultiselect = document.querySelector("[data-source-multiselect]");
  const updateSourceSummary = () => {
    if (!sourceMultiselect) return;
    const checked = [...sourceMultiselect.querySelectorAll('input[name="sourceSystemIds"]:checked')];
    const labels = checked.map((input) => input.dataset.sourceLabel);
    const summary = sourceMultiselect.querySelector("[data-source-summary]");
    if (summary) summary.textContent = labels.length ? labels.join("、") : "请选择";
  };
  sourceMultiselect?.querySelectorAll('input[name="sourceSystemIds"]').forEach((input) => {
    input.addEventListener("change", updateSourceSummary);
  });
  sourceMultiselect?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !sourceMultiselect.open) return;
    sourceMultiselect.open = false;
    sourceMultiselect.querySelector("summary")?.focus();
  });
  if (sourceMultiselectDocumentHandler) {
    document.removeEventListener("click", sourceMultiselectDocumentHandler);
  }
  sourceMultiselectDocumentHandler = (event) => {
    if (sourceMultiselect?.open && !sourceMultiselect.contains(event.target)) {
      sourceMultiselect.open = false;
    }
  };
  document.addEventListener("click", sourceMultiselectDocumentHandler);
  document.querySelector("[data-setup-plan]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const sourceSystemIds = data.getAll("sourceSystemIds");
    if (!sourceSystemIds.length) {
      if (sourceMultiselect) sourceMultiselect.open = true;
      sourceMultiselect?.querySelector("summary")?.focus();
      return toast("至少选择一个数据来源", "warning");
    }
    const payload = {
      targetSystemId: String(data.get("targetSystemId") || ""),
      sourceSystemIds,
    };
    try {
      const result = await generateSetupPlan(payload);
      state = result.state;
      render();
      toast("接入方案已生成，下游验证状态已按新方案重置");
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelectorAll("[data-open-connector]").forEach((element) => {
    element.addEventListener("click", () => {
      selectedConnectorId = element.dataset.openConnector;
      navigate("connectors");
    });
  });
  document.querySelector("[data-add-account]")?.addEventListener("click", () => {
    const code = window.prompt("请输入科目编码：", "")?.trim();
    if (!code) return;
    const activeAccounts = (state.masterData || []).filter(
      (item) => item.category === "account" && item.active !== false,
    );
    if (activeAccounts.some((item) => item.code === code)) {
      return toast("该科目编码已经存在，请直接修改现有科目", "warning");
    }
    const name = window.prompt("请输入科目名称：", "")?.trim();
    if (!name) return;
    const now = new Date().toISOString();
    state.masterData.push({
      id: `MD-ACCOUNT-${Date.now()}`,
      category: "account",
      categoryLabel: "科目",
      code,
      name,
      group: "",
      normalBalance: "借",
      status: "启用",
      requiredDimensions: [],
      version: 1,
      active: true,
      source: "用户新增",
      editedAt: now,
    });
    appendAudit(state, "新增科目", `${code} ${name}`, "创建用户维护的科目版本 v1");
    saveState(state);
    render();
    toast(`已新增科目 ${code} ${name}`);
  });
  document.querySelectorAll("[data-save-account]").forEach((element) => {
    element.addEventListener("click", () => {
      const original = (state.masterData || []).find((item) => item.id === element.dataset.saveAccount);
      const row = element.closest("[data-account-row]");
      if (!original || !row) return;
      const field = (name) => row.querySelector(`[data-account-field="${name}"]`)?.value.trim() || "";
      const code = field("code");
      const name = field("name");
      if (!code || !name) return toast("科目编码和科目名称不能为空", "warning");
      const duplicate = (state.masterData || []).find((item) =>
        item.id !== original.id
        && item.category === "account"
        && item.active !== false
        && item.code === code);
      if (duplicate) return toast("启用科目中已经存在相同编码", "warning");
      const now = new Date().toISOString();
      original.active = false;
      original.supersededAt = now;
      const updated = {
        ...original,
        id: `MD-ACCOUNT-${Date.now()}`,
        code,
        name,
        group: field("group"),
        normalBalance: field("normalBalance"),
        status: field("status"),
        version: Number(original.version || 0) + 1,
        active: true,
        source: "用户修改",
        editedAt: now,
        supersedesMasterDataId: original.id,
      };
      delete updated.supersededAt;
      state.masterData.push(updated);
      appendAudit(state, "修改科目", `${code} ${name}`, `保留原版本并创建 v${updated.version}`);
      saveState(state);
      editingMasterDataId = null;
      render();
      toast(`科目 ${code} 已保存为 v${updated.version}`);
    });
  });
  document.querySelectorAll("[data-delete-account]").forEach((element) => {
    element.addEventListener("click", () => {
      const account = (state.masterData || []).find((item) => item.id === element.dataset.deleteAccount);
      if (!account || !window.confirm(`确认停用并移除科目 ${account.code} ${account.name}？历史版本仍会保留。`)) return;
      account.active = false;
      account.supersededAt = new Date().toISOString();
      appendAudit(state, "删除科目", `${account.code} ${account.name}`, `停用科目版本 v${account.version || 1}`);
      saveState(state);
      editingMasterDataId = null;
      render();
      toast(`已移除科目 ${account.code}`);
    });
  });
  document.querySelector("[data-restore-default-accounts]")?.addEventListener("click", async () => {
    if (!window.confirm("恢复默认科目会停用当前全部科目版本，再载入《小企业会计准则》默认表。历史版本仍会保留。是否继续？")) return;
    try {
      const result = await restoreDefaultAccounts();
      state = result.state;
      render();
      toast(`已恢复 ${result.count} 个默认科目`);
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelector("[data-global-search]")?.addEventListener("input", (event) => {
    query = event.target.value;
    if (!["events", "vouchers", "exceptions", "query"].includes(route) && query) {
      route = "events";
      window.history.replaceState({}, "", routeHash(route));
    }
    render();
    requestAnimationFrame(() => {
      const input = document.querySelector("[data-global-search]");
      input?.focus();
      input?.setSelectionRange(query.length, query.length);
    });
  });
  document.querySelectorAll("[data-event-id]").forEach((element) => {
    element.addEventListener("click", () => {
      state.selectedEventId = element.dataset.eventId;
      saveState(state);
      render();
    });
  });
  document.querySelector("[data-choose-files]")?.addEventListener("click", () => document.querySelector("#file-input").click());
  document.querySelector("#file-input")?.addEventListener("change", (event) => addFiles(event.target.files));
  document.querySelector("[data-choose-folder]")?.addEventListener("click", () => document.querySelector("#folder-input").click());
  document.querySelector("#folder-input")?.addEventListener("change", (event) => addFiles(event.target.files));
  const dropZone = document.querySelector("[data-drop-zone]");
  dropZone?.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
  dropZone?.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
  dropZone?.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    addFiles(event.dataTransfer.files);
  });
  document.querySelectorAll("[data-remove-file]").forEach((element) => {
    element.addEventListener("click", () => {
      pendingFiles.splice(Number(element.dataset.removeFile), 1);
      importPreview = null;
      importPreviewError = "";
      importPreviewLoading = false;
      fieldMapping = {};
      mappingTemplateName = "";
      render();
    });
  });
  document.querySelectorAll("[data-mapping-field]").forEach((element) => {
    element.addEventListener("change", () => {
      fieldMapping[element.dataset.mappingField] = element.value;
    });
  });
  document.querySelectorAll('[data-mapping-multi-field="amount"]').forEach((element) => {
    element.addEventListener("change", () => {
      const selected = [...document.querySelectorAll('[data-mapping-multi-field="amount"]:checked')]
        .map((item) => item.value);
      fieldMapping.amount = selected;
      const summary = document.querySelector('[data-mapping-multi-summary="amount"]');
      if (summary) summary.textContent = selected.length ? selected.join("、") : "请选择付款金额字段";
    });
  });
  document.querySelector("[data-template-name]")?.addEventListener("input", (event) => {
    mappingTemplateName = event.target.value;
  });
  document.querySelector("[data-run-import]")?.addEventListener("click", runImport);
  document.querySelector("[data-download-template]")?.addEventListener("click", () => {
    downloadBlob("业务数据空白模板.csv", "\uFEFF公司,账簿,业务类型,业务日期,供应商,付款金额,审批单号,部门,项目,摘要\n", "text/csv;charset=utf-8");
  });
  document.querySelector("[data-download-master-template]")?.addEventListener("click", () => {
    downloadBlob(
      "基础资料导入模板.csv",
      "\uFEFF基础资料类型,编码,名称,状态,辅助核算\n",
      "text/csv;charset=utf-8",
    );
  });
  document.querySelector("[data-download-errors]")?.addEventListener("click", () => {
    const rows = [
      ["文件", "错误原因"],
      ...(importResult?.errors || []).map((item) => [item.file, item.message]),
    ];
    const csv = `\uFEFF${rows.map((row) =>
      row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n")}`;
    downloadBlob(`导入错误明细_${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv;charset=utf-8");
  });
  document.querySelectorAll("[data-generate]").forEach((element) => element.addEventListener("click", () => generateVoucher(element.dataset.generate)));
  document.querySelectorAll("[data-edit-voucher]").forEach((element) => element.addEventListener("click", () => {
    editingVoucherId = element.dataset.editVoucher;
    render();
  }));
  document.querySelectorAll("[data-cancel-edit]").forEach((element) => element.addEventListener("click", () => {
    editingVoucherId = null;
    render();
  }));
  document.querySelectorAll("[data-save-edit]").forEach((element) => element.addEventListener("click", () => saveVoucherEdits(element.dataset.saveEdit)));
  document.querySelectorAll("[data-approve]").forEach((element) => element.addEventListener("click", () => approveVoucher(element.dataset.approve)));
  document.querySelectorAll("[data-allow-push]").forEach((element) => element.addEventListener("click", () => {
    const voucher = state.vouchers.find((item) => item.id === element.dataset.allowPush);
    if (!voucher || voucher.status !== "已确认" || !voucher.financeReviewed) return;
    if (!window.confirm(`确认允许凭证 ${voucher.number} 保存到目标 ERP 草稿吗？系统不会提交、审核或过账。`)) return;
    voucher.pushAllowed = true;
    persist("允许推送", voucher.number, `${state.operator} 单独确认仅保存目标 ERP 草稿`);
    toast("已允许保存草稿，推送前仍会执行完整预检");
  }));
  document.querySelector("[data-batch-generate]")?.addEventListener("click", batchGenerateVouchers);
  document.querySelector("[data-batch-approve]")?.addEventListener("click", batchApproveVouchers);
  document.querySelectorAll("[data-push]").forEach((element) => element.addEventListener("click", () => pushVoucher(element.dataset.push)));
  document.querySelectorAll("[data-recheck]").forEach((element) => element.addEventListener("click", async () => {
    try {
      const voucher = state.vouchers.find((item) => item.id === element.dataset.recheck);
      const connector = state.connectors.find((item) =>
        item.name === voucher?.externalReference?.system);
      const connectorId = connector?.id || state.activeFinanceConnectorId;
      if (!connectorId) return toast("未找到真实目标 ERP 连接器", "warning");
      const result = await recheckExternalVoucher(element.dataset.recheck, connectorId);
      state = result.state;
      render();
      toast(result.message, result.voucher.status === "已推送" ? "success" : "warning");
    } catch (error) {
      toast(error.message, "warning");
    }
  }));
  document.querySelectorAll("[data-export]").forEach((element) => element.addEventListener("click", () => exportVoucher(element.dataset.export)));
  document.querySelectorAll("[data-return]").forEach((element) => element.addEventListener("click", () => {
    const voucher = state.vouchers.find((item) => item.id === element.dataset.return);
    if (!voucher || voucher.status === "已推送") {
      toast("已推送凭证不能在本地直接修改", "warning");
      return;
    }
    const reason = window.prompt("请填写退回原因：", "");
    if (!reason?.trim()) return toast("必须填写退回原因", "warning");
    voucher.status = "待处理";
    const event = state.events.find((item) => voucher.sourceEventIds.includes(item.id));
    if (event) event.status = "待补充";
    persist("退回凭证", voucher.number, `退回业务事项补充来源资料；原因：${reason.trim()}`);
  }));
  document.querySelectorAll("[data-resolve]").forEach((element) => element.addEventListener("click", () => {
    const exception = state.exceptions.find((item) => item.id === element.dataset.resolve);
    const resolution = window.prompt("请填写解决方式或核对结论：", "");
    if (!resolution?.trim()) return toast("必须填写异常解决方式", "warning");
    if (exception.type === "辅助核算主数据") {
      const voucher = state.vouchers.find((item) => item.id === exception.voucherId);
      const sourceEvent = state.events.find((item) => item.id === exception.eventId);
      const rule = state.rules.find((item) => item.id === voucher?.appliedRuleId);
      if (!voucher || !sourceEvent || !rule) {
        return toast("无法重建辅助核算校验上下文，请退回凭证后重新生成", "warning");
      }
      let refreshed;
      try {
        refreshed = createPurchaseVoucher(
          sourceEvent,
          1,
          { ...rule, enabled: true },
          ruleEditorContext({ resolveDimensionMasterData: true }),
        );
      } catch (error) {
        return toast(`辅助核算重新校验失败：${error.message}`, "warning");
      }
      const dimensionValid = refreshed.lines.every((line) =>
        Object.values(line.dimensionRefs || {})
          .every((reference) => reference.status === "matched"));
      if (!dimensionValid || refreshed.lines.length !== voucher.lines.length) {
        return toast("辅助核算主数据重新校验仍未通过，异常不能关闭", "warning");
      }
      voucher.lines.forEach((line, index) => {
        line.dimensions = refreshed.lines[index].dimensions;
        line.dimensionRefs = refreshed.lines[index].dimensionRefs;
        line.requiredDimensions = refreshed.lines[index].requiredDimensions;
      });
      voucher.validation = validateVoucher(voucher);
      if (!voucher.validation.valid) {
        return toast(`凭证重新校验未通过：${voucher.validation.errors[0]}`, "warning");
      }
      voucher.status = "待审核";
    }
    exception.status = "已解决";
    exception.resolution = resolution.trim();
    exception.resolvedBy = state.operator;
    exception.resolvedAt = new Date().toISOString();
    const event = state.events.find((item) => item.id === exception.eventId);
    if (event) {
      event.exceptionIds = event.exceptionIds.filter((id) => id !== exception.id);
      event.status = getVoucherForEvent(event.id) ? "待审核" : "可生成";
    }
    persist("解决异常", exception.title, `解决方式：${resolution.trim()}；相关事项已重新校验`);
    toast("异常已解决，事项已重新校验");
  }));
  document.querySelectorAll("[data-confirm-ocr]").forEach((element) => element.addEventListener("click", () => {
    confirmOcrCandidate(element.dataset.confirmOcr, element.closest(".ocr-confirm-card"));
  }));
  document.querySelectorAll("[data-confirm-allocation]").forEach((element) => element.addEventListener("click", () => {
    confirmPartialAllocation(element.dataset.confirmAllocation, element.closest(".ocr-confirm-card"));
  }));
  document.querySelectorAll("[data-open-event], [data-open-voucher]").forEach((element) => element.addEventListener("click", () => {
    state.selectedEventId = element.dataset.openEvent || element.dataset.openVoucher;
    route = element.dataset.openVoucher ? "vouchers" : "events";
    window.history.pushState({}, "", routeHash(route));
    saveState(state);
    render();
  }));
  document.querySelectorAll("[data-toggle-rule]").forEach((element) => element.addEventListener("click", () => {
    const rule = state.rules.find((item) => item.id === element.dataset.toggleRule);
    if (rule.supersededAt) return toast("历史规则版本不能重新启用；请从当前版本创建新版本", "warning");
    if (!rule.enabled) {
      const posting = rule.posting || {};
      if (!postingRuleComplete(rule)) {
        return toast("场景分录不完整，或同一行同时配置了借贷金额，不能启用", "warning");
      }
      const accounts = new Set((state.masterData || [])
        .filter((item) => item.category === "account" && item.active !== false)
        .map((item) => item.code));
      const postingAccounts = Array.isArray(posting.lines) && posting.lines.length
        ? posting.lines.map((line) => line.accountCode)
        : [posting.debitAccountCode, posting.creditAccountCode];
      if (postingAccounts.some((accountCode) => !accounts.has(accountCode))) {
        return toast("规则科目尚未在目标基础资料中验证，不能启用", "warning");
      }
      try {
        const preview = createPurchaseVoucher(
          rulePreviewEvent(rule),
          1,
          { ...rule, enabled: true },
          ruleEditorContext(),
        );
        const validation = validateVoucher(preview);
        if (!validation.valid) return toast(`样例校验未通过：${validation.errors[0]}`, "warning");
      } catch (error) {
        return toast(`样例校验未通过：${error.message}`, "warning");
      }
      if (!window.confirm(`确认规则 ${rule.name} 的字段、科目和辅助核算配置完整，并启用 v${rule.version} 吗？`)) return;
      rule.confirmedBy = state.operator;
      rule.confirmedAt = new Date().toISOString();
    }
    rule.enabled = !rule.enabled;
    rule.status = rule.enabled ? "已启用" : "已停用";
    persist("修改规则", rule.name, `${rule.enabled ? "启用" : "停用"}规则版本 ${rule.version}`);
  }));
  document.querySelectorAll("[data-query-view]").forEach((element) => element.addEventListener("click", () => {
    queryView = element.dataset.queryView;
    render();
  }));
  document.querySelector("[data-external-query-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!String(values.number || "").trim() && !String(values.reference || "").trim()) {
      return toast("请输入外部凭证号或幂等引用", "warning");
    }
    try {
      toast("正在从目标财务系统实时查询");
      const result = await queryExternalVoucher(values.connectorId, {
        number: String(values.number || "").trim(),
        reference: String(values.reference || "").trim(),
      });
      state = result.state;
      render();
      toast(result.result.found ? "已查到外部凭证" : "目标系统未找到对应凭证", result.result.found ? "success" : "warning");
    } catch (error) {
      state = await loadState();
      render();
      toast(error.message, "warning");
    }
  });
  document.querySelector("[data-external-ledger-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      toast("正在从目标财务系统查询账簿");
      const result = await queryExternalLedger(values.connectorId, {
        ledger: values.ledger,
        period: values.period,
        account: values.account,
        dimension: values.dimension,
      });
      state = result.state;
      render();
      toast(`账簿查询完成：${result.result.rows.length} 行`);
    } catch (error) {
      state = await loadState();
      render();
      toast(error.message, "warning");
    }
  });
  document.querySelector("[data-external-report-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      toast("正在从目标财务系统查询报表");
      const result = await queryExternalReport(values.connectorId, {
        reportType: values.reportType,
        period: values.period,
      });
      state = result.state;
      render();
      toast(`${result.result.label}查询完成：${result.result.rows.length} 行`);
    } catch (error) {
      state = await loadState();
      render();
      toast(error.message, "warning");
    }
  });
  document.querySelector("[data-add-rule]")?.addEventListener("click", () => {
    if (ruleEditorOpen) {
      ruleEditorOpen = false;
      editingRuleId = null;
      ruleEditorDraft = null;
      selectedRuleLineIndex = 0;
      expandedRuleLineIndex = null;
      expandedRuleLineField = "";
    } else {
      editingRuleId = null;
      ruleEditorOpen = true;
      ruleEditorDraft = ruleDraftFromRule();
      selectedRuleLineIndex = 0;
      expandedRuleLineIndex = null;
      expandedRuleLineField = "";
    }
    render();
  });
  document.querySelectorAll("[data-edit-rule]").forEach((element) => element.addEventListener("click", () => {
    editingRuleId = element.dataset.editRule;
    ruleEditorOpen = true;
    ruleEditorDraft = ruleDraftFromRule(
      state.rules.find((rule) => rule.id === editingRuleId),
    );
    selectedRuleLineIndex = 0;
    expandedRuleLineIndex = null;
    expandedRuleLineField = "";
    render();
  }));
  document.querySelector("[data-cancel-rule]")?.addEventListener("click", () => {
    ruleEditorOpen = false;
    editingRuleId = null;
    ruleEditorDraft = null;
    selectedRuleLineIndex = 0;
    expandedRuleLineIndex = null;
    expandedRuleLineField = "";
    render();
  });
  document.querySelectorAll("[data-rule-line-account-code]").forEach((element) => {
    element.addEventListener("change", (event) => {
      const account = (state.masterData || []).find((item) =>
        item.category === "account"
        && item.active !== false
        && item.status !== "停用"
        && item.code === event.target.value.trim());
      if (account) {
        const nameInput = event.target.closest("[data-rule-line-config]")
          ?.querySelector("[data-rule-line-account-name]");
        if (nameInput) nameInput.value = account.name;
      }
    });
  });
  document.querySelectorAll("[data-rule-line-account-source]").forEach((element) => {
    element.addEventListener("change", () => {
      captureRuleEditorDraft();
      render();
    });
  });
  document.querySelectorAll("[data-rule-line-spec-mode]").forEach((element) => {
    element.addEventListener("change", () => {
      captureRuleEditorDraft();
      render();
    });
  });
  document.querySelectorAll("[data-rule-dimension-key]").forEach((element) => {
    element.addEventListener("change", () => {
      const nextKey = element.value;
      const previousKey = element.dataset.currentKey || "";
      const lineIndex = Number(element.closest("[data-rule-line-config]")?.dataset.ruleLineConfig);
      element.value = previousKey;
      captureRuleEditorDraft();
      const line = ruleEditorDraft.posting.lines[lineIndex];
      const bindings = normalizeDimensionBindings(line);
      if (bindings.some((binding) => binding.key === nextKey)) {
        toast("同一分录不能重复配置相同辅助核算", "warning");
        return render();
      }
      const binding = bindings.find((item) => item.key === previousKey);
      if (binding) binding.key = nextKey;
      line.dimensionBindings = bindings;
      line.dimensions = Object.fromEntries(
        bindings.map((item) => [item.key, item.valueSpec]),
      );
      line.requiredDimensions = bindings
        .filter((item) => item.required)
        .map((item) => item.key);
      render();
    });
  });
  document.querySelectorAll("[data-insert-summary-token]").forEach((element) => {
    element.addEventListener("click", () => {
      const input = element.closest("[data-rule-line-config]")?.querySelector("[data-rule-line-summary]");
      if (!input) return;
      const token = `{${element.dataset.insertSummaryToken}}`;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = `${input.value.slice(0, start)}${token}${input.value.slice(end)}`;
      input.focus();
      input.setSelectionRange(start + token.length, start + token.length);
    });
  });
  document.querySelector("[data-add-rule-line]")?.addEventListener("click", () => {
    captureRuleEditorDraft();
    ruleEditorDraft.posting.lines.push(blankRulePostingLine("debit"));
    selectedRuleLineIndex = ruleEditorDraft.posting.lines.length - 1;
    expandedRuleLineIndex = null;
    expandedRuleLineField = "";
    render();
  });
  document.querySelectorAll("[data-edit-rule-line]").forEach((element) => {
    element.addEventListener("click", () => {
      captureRuleEditorDraft();
      const index = Number(element.dataset.editRuleLine);
      const field = element.dataset.ruleLineField || "summary";
      const isSameCell = expandedRuleLineIndex === index && expandedRuleLineField === field;
      selectedRuleLineIndex = index;
      expandedRuleLineIndex = isSameCell ? null : index;
      expandedRuleLineField = isSameCell ? "" : field;
      render();
    });
  });
  document.querySelectorAll("[data-close-rule-line]").forEach((element) => {
    element.addEventListener("click", () => {
      captureRuleEditorDraft();
      expandedRuleLineIndex = null;
      expandedRuleLineField = "";
      render();
    });
  });
  document.querySelectorAll("[data-select-rule-line]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      captureRuleEditorDraft();
      selectedRuleLineIndex = Number(element.dataset.selectRuleLine);
      expandedRuleLineIndex = null;
      expandedRuleLineField = "";
      render();
    });
  });
  document.querySelectorAll("[data-insert-rule-line]").forEach((element) => {
    element.addEventListener("click", () => {
      captureRuleEditorDraft();
      const index = Number(element.dataset.insertRuleLine);
      ruleEditorDraft.posting.lines.splice(index + 1, 0, blankRulePostingLine("debit"));
      selectedRuleLineIndex = index + 1;
      expandedRuleLineIndex = null;
      expandedRuleLineField = "";
      render();
    });
  });
  document.querySelectorAll("[data-delete-rule-line]").forEach((element) => {
    element.addEventListener("click", () => {
      captureRuleEditorDraft();
      if (ruleEditorDraft.posting.lines.length <= 2) {
        return toast("凭证场景至少保留两条分录", "warning");
      }
      const index = Number(element.dataset.deleteRuleLine);
      ruleEditorDraft.posting.lines.splice(index, 1);
      selectedRuleLineIndex = Math.min(index, ruleEditorDraft.posting.lines.length - 1);
      expandedRuleLineIndex = null;
      expandedRuleLineField = "";
      render();
    });
  });
  document.querySelectorAll("[data-add-rule-dimension]").forEach((element) => {
    element.addEventListener("click", () => {
      captureRuleEditorDraft();
      const index = Number(element.dataset.addRuleDimension);
      const key = document.querySelector(`[data-new-rule-dimension="${index}"]`)?.value || "";
      const line = ruleEditorDraft.posting.lines[index];
      if (!line || !key) return;
      const bindings = normalizeDimensionBindings(line);
      if (bindings.some((binding) => binding.key === key)) {
        return toast("同一分录不能重复配置相同辅助核算", "warning");
      }
      line.dimensionBindings = [...bindings, defaultDimensionBinding(key)];
      line.dimensions = Object.fromEntries(
        line.dimensionBindings.map((binding) => [binding.key, binding.valueSpec]),
      );
      line.requiredDimensions = line.dimensionBindings
        .filter((binding) => binding.required)
        .map((binding) => binding.key);
      render();
    });
  });
  document.querySelectorAll("[data-remove-rule-dimension]").forEach((element) => {
    element.addEventListener("click", () => {
      const bindingRow = element.closest("[data-rule-dimension-binding]");
      const key = bindingRow?.querySelector("[data-rule-dimension-key]")?.value || "";
      captureRuleEditorDraft();
      const line = ruleEditorDraft.posting.lines[Number(element.dataset.removeRuleDimension)];
      if (!line || !key) return;
      line.dimensionBindings = normalizeDimensionBindings(line)
        .filter((binding) => binding.key !== key);
      line.dimensions = Object.fromEntries(
        line.dimensionBindings.map((binding) => [binding.key, binding.valueSpec]),
      );
      line.requiredDimensions = line.dimensionBindings
        .filter((binding) => binding.required)
        .map((binding) => binding.key);
      render();
    });
  });
  document.querySelector("[data-save-rule]")?.addEventListener("click", () => {
    const draft = captureRuleEditorDraft();
    const { name, priority, match, posting } = draft;
    if (!name || !match.businessType || !Number.isInteger(priority) || priority < 1) {
      return toast("请完整填写场景名称、优先级和业务类型", "warning");
    }
    if (posting.lines.length < 2) return toast("凭证场景至少需要两条分录", "warning");
    const duplicateDimensionIndex = posting.lines.findIndex((line) => {
      const keys = (line.dimensionBindings || []).map((binding) => binding.key);
      return new Set(keys).size !== keys.length;
    });
    if (duplicateDimensionIndex >= 0) {
      return toast(`第 ${duplicateDimensionIndex + 1} 行存在重复辅助核算类型`, "warning");
    }
    const incompleteIndex = posting.lines.findIndex((line) =>
      !line.summaryTemplate || (
        line.accountSource?.mode === "field"
          ? line.accountSource.field !== "debitAccount"
          : !line.accountCode || !line.accountName
      ));
    if (incompleteIndex >= 0) {
      return toast(`第 ${incompleteIndex + 1} 行缺少摘要或有效科目来源`, "warning");
    }
    const doubleSidedIndex = posting.lines.findIndex((line) =>
      ruleAmountSpecActive(line.debitAmount) && ruleAmountSpecActive(line.creditAmount));
    if (doubleSidedIndex >= 0) {
      return toast(`第 ${doubleSidedIndex + 1} 行不能同时配置借方和贷方金额`, "warning");
    }
    if (!postingRuleComplete({ posting })) {
      return toast("分录必须至少包含一条借方和一条贷方金额配置", "warning");
    }
    const debitLine = posting.lines.find((line) => ruleAmountSpecActive(line.debitAmount));
    const creditLine = posting.lines.find((line) => ruleAmountSpecActive(line.creditAmount));
    const condition = `业务类型 = ${match.businessType}${match.counterparty ? `；供应商/客商 = ${match.counterparty}` : ""}`;
    const usesKingdeeRate = posting.lines.some((line) =>
      line.exchangeRate?.mode === "field" && line.exchangeRate.field === "kingdeeExchangeRate");
    const accountAction = (line) => line.accountSource?.mode === "field"
      ? "审批数据处理.科目"
      : `${line.accountCode} ${line.accountName}`;
    const action = `${posting.lines.length} 行分录；借：${accountAction(debitLine)}；贷：${accountAction(creditLine)}${usesKingdeeRate ? "；汇率按金蝶体系匹配" : ""}`;
    const changes = {
      name,
      priority,
      condition,
      action,
      match,
      posting: {
        lines: posting.lines,
        debitAccountCode: debitLine.accountCode,
        debitAccountName: debitLine.accountName,
        creditAccountCode: creditLine.accountCode,
        creditAccountName: creditLine.accountName,
      },
    };
    const now = new Date().toISOString();
    const ruleId = `RULE-${Date.now()}`;
    const original = editingRuleId
      ? state.rules.find((rule) => rule.id === editingRuleId)
      : null;
    let savedRule;
    if (original) {
      savedRule = createRuleVersion(original, changes, state.operator, ruleId, now);
      original.enabled = false;
      original.status = "历史版本";
      original.supersededAt = now;
      original.supersededByRuleId = savedRule.id;
      state.rules.unshift(savedRule);
      appendAudit(
        state,
        "修改规则",
        savedRule.name,
        `保留原规则 ${original.id} v${original.version}，创建待确认版本 ${savedRule.id} v${savedRule.version}`,
      );
    } else {
      savedRule = {
        id: ruleId,
        lineageId: ruleId,
        ...changes,
        version: "1.0",
        enabled: false,
        status: "待启用",
        createdBy: state.operator,
        createdAt: now,
      };
      state.rules.unshift(savedRule);
      appendAudit(state, "创建规则", name, `创建待启用规则 v1.0，优先级 ${priority}`);
    }
    ruleEditorOpen = false;
    editingRuleId = null;
    ruleEditorDraft = null;
    selectedRuleLineIndex = 0;
    expandedRuleLineIndex = null;
    expandedRuleLineField = "";
    saveState(state);
    render();
    toast(original ? `已创建待确认规则 v${savedRule.version}` : "规则 v1.0 已创建，等待人工确认启用");
  });
  document.querySelectorAll("[data-select-connector]").forEach((element) => {
    element.addEventListener("click", () => {
      selectedConnectorId = element.dataset.selectConnector;
      render();
    });
  });
  document.querySelectorAll("[data-approval-panel]").forEach((element) => {
    element.addEventListener("click", () => {
      const panelId = element.dataset.approvalPanel;
      if (!["query", "mapping", "records"].includes(panelId)) return;
      approvalWorkspacePanel = panelId;
      document.querySelectorAll("[data-approval-panel]").forEach((tab) => {
        const isActive = tab.dataset.approvalPanel === panelId;
        tab.classList.toggle("active", isActive);
        tab.setAttribute("aria-selected", String(isActive));
      });
      document.querySelectorAll("[data-approval-page]").forEach((panel) => {
        panel.hidden = panel.dataset.approvalPage !== panelId;
      });
      if (panelId !== "records") {
        selectedApprovalDetailId = null;
        editingApprovalCounterpartyId = null;
      }
    });
  });
  document.querySelector("[data-select-approval-connector]")?.addEventListener("change", (event) => {
    selectedApprovalConnectorId = event.target.value;
    selectedApprovalProfileId = "";
    approvalDataFilters = { keyword: "" };
    approvalDataCustomFilterDrafts = [];
    approvalDataCustomFilters = [];
    approvalFiltersExpanded = false;
    selectedApprovalRecordIds.clear();
    selectedApprovalDetailId = null;
    editingApprovalCounterpartyId = null;
    render();
  });
  document.querySelector("[data-select-approval-profile]")?.addEventListener("change", (event) => {
    selectedApprovalProfileId = event.target.value;
    approvalWorkspacePanel = "query";
    approvalDataFilters = { keyword: "" };
    approvalDataCustomFilterDrafts = [];
    approvalDataCustomFilters = [];
    approvalFiltersExpanded = false;
    selectedApprovalRecordIds.clear();
    selectedApprovalDetailId = null;
    editingApprovalCounterpartyId = null;
    render();
  });
  document.querySelector("[data-add-approval-profile]")?.addEventListener("click", () => {
    selectedApprovalProfileId = "__new__";
    approvalWorkspacePanel = "query";
    approvalDataFilters = { keyword: "" };
    approvalDataCustomFilterDrafts = [];
    approvalDataCustomFilters = [];
    approvalFiltersExpanded = false;
    selectedApprovalRecordIds.clear();
    selectedApprovalDetailId = null;
    editingApprovalCounterpartyId = null;
    render();
    document.querySelector('input[name="approvalCode"]')?.focus();
  });
  document.querySelectorAll("[data-save-connector]").forEach((element) =>
    element.addEventListener("click", () => saveConnectorConfiguration(element.dataset.saveConnector)));
  document.querySelectorAll("[data-save-approval-config]").forEach((element) =>
    element.addEventListener("click", () => saveApprovalDataConfiguration(element.dataset.saveApprovalConfig)));
  document.querySelector("[data-open-approval-additional-field]")?.addEventListener("click", (event) => {
    const editor = document.querySelector("[data-approval-additional-field-editor]");
    if (!editor) return;
    editor.hidden = !editor.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!editor.hidden));
    if (!editor.hidden) editor.querySelector("select")?.focus();
  });
  document.querySelector("[data-cancel-approval-additional-field]")?.addEventListener("click", () => {
    const editor = document.querySelector("[data-approval-additional-field-editor]");
    const trigger = document.querySelector("[data-open-approval-additional-field]");
    if (editor) editor.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.focus();
  });
  document.querySelector("[data-add-approval-additional-field]")?.addEventListener("click", (event) =>
    addApprovalAdditionalField(event.currentTarget.dataset.addApprovalAdditionalField));
  document.querySelectorAll("[data-remove-approval-additional-field]").forEach((element) =>
    element.addEventListener("click", () =>
      removeApprovalAdditionalField(
        element.dataset.approvalAdditionalConnector,
        element.dataset.removeApprovalAdditionalField,
      )));
  document.querySelectorAll("[data-test-real]").forEach((element) =>
    element.addEventListener("click", () => runConnectorOperation(element.dataset.testReal, "test")));
  document.querySelectorAll("[data-read-feishu-fields]").forEach((element) =>
    element.addEventListener("click", () => readFeishuApprovalFields(element.dataset.readFeishuFields)));
  document.querySelectorAll("[data-sync-approvals]").forEach((element) =>
    element.addEventListener("click", () => runConnectorOperation(element.dataset.syncApprovals, "approvals")));
  document.querySelectorAll("[data-sync-master]").forEach((element) =>
    element.addEventListener("click", () => runConnectorOperation(element.dataset.syncMaster, "master")));
  document.querySelector("[data-toggle-approval-filters]")?.addEventListener("click", () => {
    approvalFiltersExpanded = !approvalFiltersExpanded;
    render();
  });
  document.querySelector("[data-approval-filter-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    approvalDataFilters = {
      keyword: String(values.keyword || ""),
    };
    approvalFiltersExpanded = false;
    render();
  });
  document.querySelector("[data-add-approval-custom-filter]")?.addEventListener("click", () => {
    approvalDataCustomFilterDrafts.push(createApprovalDataCustomFilter());
    approvalFiltersExpanded = true;
    render();
  });
  document.querySelectorAll("[data-approval-custom-filter]").forEach((row) => {
    const approvalFilterFields = selectedApprovalFilterFields();
    const condition = approvalDataCustomFilterDrafts.find((item) =>
      item.id === row.dataset.approvalCustomFilter);
    if (!condition) return;
    row.querySelector("[data-approval-custom-field]")?.addEventListener("change", (event) => {
      condition.field = event.currentTarget.value;
      condition.operator = approvalProcessingOperators(
        condition.field,
        approvalFilterFields,
      )[0]?.key || "equals";
      condition.value = approvalProcessingField(
        condition.field,
        approvalFilterFields,
      ).type === "status" ? "approved" : "";
      render();
    });
    row.querySelector("[data-approval-custom-operator]")?.addEventListener("change", (event) => {
      condition.operator = event.currentTarget.value;
      render();
    });
    const valueControl = row.querySelector("[data-approval-custom-value]");
    const updateValue = (event) => {
      condition.value = event.currentTarget.value;
    };
    valueControl?.addEventListener("input", updateValue);
    valueControl?.addEventListener("change", updateValue);
  });
  document.querySelectorAll("[data-remove-approval-custom-filter]").forEach((element) => {
    element.addEventListener("click", () => {
      const filterId = element.dataset.removeApprovalCustomFilter;
      approvalDataCustomFilterDrafts = approvalDataCustomFilterDrafts
        .filter((condition) => condition.id !== filterId);
      approvalDataCustomFilters = approvalDataCustomFilters
        .filter((condition) => condition.id !== filterId);
      render();
    });
  });
  document.querySelector("[data-clear-approval-custom-filters]")?.addEventListener("click", () => {
    approvalDataCustomFilterDrafts = [];
    approvalDataCustomFilters = [];
    render();
  });
  document.querySelector("[data-approval-custom-filter-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!approvalDataCustomFilterDrafts.length) return;
    const approvalFilterFields = selectedApprovalFilterFields();
    if (!approvalDataCustomFilterDrafts.every((condition) =>
      approvalConditionComplete(condition, approvalFilterFields))) {
      return toast("请完整填写每个自定义筛选条件", "warning");
    }
    approvalDataCustomFilters = approvalDataCustomFilterDrafts
      .map((condition) => ({ ...condition }));
    approvalFiltersExpanded = false;
    render();
  });
  document.querySelectorAll("[data-open-approval-detail]").forEach((element) => {
    element.addEventListener("click", () => {
      selectedApprovalDetailId = element.dataset.openApprovalDetail;
      editingApprovalCounterpartyId = null;
      render();
      document.querySelector("[data-close-approval-detail]")?.focus();
    });
  });
  const closeApprovalDetail = () => {
    selectedApprovalDetailId = null;
    render();
  };
  document.querySelectorAll("[data-close-approval-detail]").forEach((element) =>
    element.addEventListener("click", closeApprovalDetail));
  document.querySelector("[data-approval-detail-layer]")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeApprovalDetail();
  });
  document.querySelectorAll("[data-edit-approval-counterparty]").forEach((element) => {
    element.addEventListener("click", () => {
      const recordId = element.dataset.editApprovalCounterparty;
      editingApprovalCounterpartyId = (
        editingApprovalCounterpartyId === recordId ? null : recordId
      );
      selectedApprovalDetailId = null;
      render();
      document.querySelector("[data-approval-counterparty-field]")?.focus();
    });
  });
  document.querySelector("[data-cancel-approval-counterparty]")?.addEventListener("click", () => {
    editingApprovalCounterpartyId = null;
    render();
  });
  document.querySelector("[data-approval-counterparty-field]")?.addEventListener("change", (event) => {
    const form = event.currentTarget.closest("[data-approval-counterparty-form]");
    const record = (state.events || []).find((item) =>
      item.id === form?.dataset.approvalCounterpartyForm);
    const field = approvalRecordFieldEntries(record)
      .find((item) => item.id === event.currentTarget.value);
    const preview = form?.querySelector("[data-approval-counterparty-preview]");
    if (preview) preview.textContent = field?.displayValue || "请选择字段";
  });
  document.querySelector("[data-approval-counterparty-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const recordId = event.currentTarget.dataset.approvalCounterpartyForm;
    const record = (state.events || []).find((item) => item.id === recordId);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      assignApprovalCounterpartyFromField({
        record,
        fieldId: String(values.approvalFieldId || ""),
        selectedAt: new Date().toISOString(),
        selectedBy: state.operator || "本机用户",
      });
      const sourceName = record.counterpartyFieldSelection.fieldName;
      editingApprovalCounterpartyId = null;
      persist(
        "修改审批供应商 / 客商",
        record.approvalNo || record.reference || record.externalId || record.id,
        `仅修改当前审批记录；使用审批字段「${sourceName}」`,
      );
      toast(`已使用“${sourceName}”更新本条审批的供应商 / 客商`);
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelectorAll("[data-select-approval-record]").forEach((element) => {
    element.addEventListener("change", () => {
      const recordId = element.dataset.selectApprovalRecord;
      if (element.checked) selectedApprovalRecordIds.add(recordId);
      else selectedApprovalRecordIds.delete(recordId);
      approvalFiltersExpanded = false;
      render();
    });
  });
  document.querySelector("[data-select-visible-approvals]")?.addEventListener("change", (event) => {
    document.querySelectorAll("[data-select-approval-record]").forEach((element) => {
      const recordId = element.dataset.selectApprovalRecord;
      if (event.currentTarget.checked) selectedApprovalRecordIds.add(recordId);
      else selectedApprovalRecordIds.delete(recordId);
    });
    approvalFiltersExpanded = false;
    render();
  });
  document.querySelector("[data-clear-approval-selection]")?.addEventListener("click", () => {
    selectedApprovalRecordIds.clear();
    render();
  });
  document.querySelector("[data-confirm-approval-selection]")?.addEventListener("click", () =>
    updateSelectedApprovalTransfer(true));
  document.querySelector("[data-revoke-approval-selection]")?.addEventListener("click", () =>
    updateSelectedApprovalTransfer(false));
  document.querySelectorAll("[data-union-account-event]").forEach((element) => {
    element.addEventListener("change", async () => {
      const approval = state.events.find((item) => item.id === element.dataset.unionAccountEvent);
      const account = (state.masterData || []).find((item) =>
        item.id === element.value
        && item.category === "account"
        && item.active !== false
        && item.status !== "停用");
      if (!approval || !account) {
        render();
        return toast("请选择当前有效的科目主数据", "warning");
      }
      const before = structuredClone(approval);
      const beforeAudit = structuredClone(state.auditLog || []);
      try {
        assignApprovalAccount(
          approval,
          account,
          state.operator || "本机操作者",
          new Date().toISOString(),
        );
        appendAudit(
          state,
          "补充审批科目",
          approval.reference || approval.externalId,
          `本地字段设置为 ${account.code} ${account.name}；审批原始资料未修改`,
        );
        await saveState(state);
        render();
        toast(`已保存 ${approval.reference || approval.externalId} 的科目`);
      } catch (error) {
        Object.assign(approval, before);
        state.auditLog = beforeAudit;
        render();
        toast(error.message, "warning");
      }
    });
  });
  document.querySelectorAll("[data-union-rule-row]").forEach((element) => {
    element.addEventListener("change", async () => {
      state.approvalUnionSelections ||= {};
      if (element.value) {
        state.approvalUnionSelections[element.dataset.unionRuleRow] = {
          ruleId: element.value,
          selectedAt: new Date().toISOString(),
          selectedBy: state.operator || "本机操作者",
        };
      } else {
        delete state.approvalUnionSelections[element.dataset.unionRuleRow];
      }
      await saveState(state);
      render();
    });
  });
  document.querySelectorAll("[data-generate-union-row]").forEach((element) => {
    element.addEventListener("click", () =>
      generateVoucherForUnionRow(element.dataset.generateUnionRow));
  });
  document.querySelector("[data-auto-generate-union]")?.addEventListener(
    "click",
    autoGenerateUnionVouchers,
  );
  document.querySelectorAll("[data-activate-finance]").forEach((element) => element.addEventListener("click", () => {
    const connector = state.connectors.find((item) => item.id === element.dataset.activateFinance);
    if (connector.status !== "connected") {
      return toast("真实财务连接器必须先通过连接测试", "warning");
    }
    state.activeFinanceConnectorId = connector.id;
    persist("切换财务推送目标", connector.name, `目标环境 ${connector.environment}`);
  }));
  document.querySelectorAll("[data-activate-workflow]").forEach((element) => element.addEventListener("click", () => {
    const connector = state.connectors.find((item) => item.id === element.dataset.activateWorkflow);
    if (connector.status !== "connected") return toast("流程连接器必须先通过连接测试", "warning");
    state.activeWorkflowConnectorId = connector.id;
    persist("切换流程数据来源", connector.name, `目标环境 ${connector.environment}`);
  }));
  document.querySelector("[data-complete-setup]")?.addEventListener("click", () => {
    const value = document.querySelector("[data-first-operator]")?.value.trim();
    if (!value) return toast("操作者名称不能为空", "warning");
    state.operator = value;
    state.operatorConfigured = true;
    persist("完成首次设置", "本机操作者", `操作者设置为 ${value}`);
    toast("本机操作者已设置");
  });
  document.querySelector("[data-save-operator]")?.addEventListener("click", () => {
    const value = document.querySelector("[data-operator-input]").value.trim();
    if (!value) return toast("操作者名称不能为空", "warning");
    state.operator = value;
    persist("修改设置", "本机操作者", `操作者更新为 ${value}`);
    toast("操作者设置已保存");
  });
  document.querySelectorAll("[data-check-environment]").forEach((element) => {
    element.addEventListener("click", async () => {
      element.disabled = true;
      try {
        environmentStatus = await runEnvironmentCheck(true, browserCapabilityChecks());
        applyBrowserCapabilityChecks();
        render();
        toast(
          environmentStatus.overallStatus === "ok" ? "环境检测全部通过" : "环境检测完成，请处理提示项",
          environmentStatus.overallStatus === "ok" ? "success" : "warning",
        );
      } catch (error) {
        toast(error.message, "warning");
      } finally {
        element.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-repair-environment]").forEach((element) => {
    element.addEventListener("click", async () => {
      try {
        const result = await repairEnvironment(element.dataset.repairEnvironment);
        if (result.environment) environmentStatus = result.environment;
        applyBrowserCapabilityChecks();
        render();
        toast(result.message || (result.restartRequired ? "修复完成，重启后生效" : "环境修复已完成"));
      } catch (error) {
        toast(error.message, "warning");
      }
    });
  });
  document.querySelectorAll("[data-update-action]").forEach((element) => {
    element.addEventListener("click", async () => {
      const action = element.dataset.updateAction;
      if (action === "apply" && !window.confirm("更新前将自动备份数据库并重启本地服务，确认继续吗？")) return;
      element.disabled = true;
      try {
        updateStatus = await runUpdateAction(action);
        runtimeStatus = await fetchRuntimeStatus();
        render();
        toast(action === "apply" ? "正在重启并更新" : "更新状态已刷新");
      } catch (error) {
        toast(error.message, "warning");
      } finally {
        element.disabled = false;
      }
    });
  });
  document.querySelector("[data-copy-diagnostic-summary]")?.addEventListener("click", async () => {
    try {
      const result = await fetchDiagnosticCopySummary();
      const copied = await copyText(result.text);
      toast(copied
        ? `问题信息已复制，可直接发给技术支持（${result.supportCode}）`
        : "请在弹窗中复制或下载问题信息");
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelectorAll("[data-diagnostic-filter]").forEach((element) => {
    element.addEventListener("change", () => {
      diagnosticFilters[element.dataset.diagnosticFilter] = element.value;
      refreshDiagnostics();
    });
  });
  document.querySelector("[data-diagnostic-search]")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    diagnosticFilters.search = event.currentTarget.value.trim();
    refreshDiagnostics();
  });
  document.querySelector("[data-refresh-diagnostics]")?.addEventListener("click", () => {
    diagnosticFilters.search = document.querySelector("[data-diagnostic-search]")?.value.trim() || "";
    refreshDiagnostics();
  });
  document.querySelectorAll("[data-copy-diagnostic]").forEach((element) => {
    element.addEventListener("click", async () => {
      const entry = diagnosticResult.items.find((item) => item.id === element.dataset.copyDiagnostic)
        || (diagnosticSummary.latestError?.id === element.dataset.copyDiagnostic ? diagnosticSummary.latestError : null);
      if (!entry) return toast("该日志已不在当前结果中，请刷新后重试", "warning");
      try {
        await copyText(diagnosticCopyText(entry));
        toast("日志已复制，可直接发送给技术支持");
      } catch {
        toast("复制失败，请展开技术详情后手动复制", "warning");
      }
    });
  });
  document.querySelector("[data-copy-visible]")?.addEventListener("click", async () => {
    try {
      await copyText(diagnosticResult.items.map(diagnosticCopyText).join("\n\n---\n\n"));
      toast(`已复制当前页 ${diagnosticResult.items.length} 条脱敏日志`);
    } catch {
      toast("复制失败，请逐条复制", "warning");
    }
  });
  document.querySelectorAll("[data-diagnostic-page]").forEach((element) => {
    element.addEventListener("click", () => {
      diagnosticPage = Math.max(0, diagnosticPage + Number(element.dataset.diagnosticPage));
      refreshDiagnostics({ keepPage: true });
    });
  });
  document.querySelector("[data-export-diagnostics]")?.addEventListener("click", async () => {
    const days = Number(document.querySelector("[data-diagnostic-export-days]")?.value || 7);
    try {
      const { blob, supportCode } = await downloadDiagnosticBundle(days);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `AutoVoucher诊断包_${supportCode || new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(url);
      appendAudit(
        state,
        "导出诊断包",
        supportCode || "本地诊断",
        `导出最近 ${days} 天脱敏运行日志；不包含原始票据、凭证分录、数据库或密钥`,
      );
      await saveState(state);
      toast(`诊断包已导出${supportCode ? `，支持编号 ${supportCode}` : ""}`);
      refreshDiagnostics({ keepPage: true });
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelector("[data-save-diagnostic-settings]")?.addEventListener("click", async () => {
    try {
      const retentionDays = Number(document.querySelector("[data-retention-days]")?.value || 30);
      const maxEntries = Number(document.querySelector("[data-max-diagnostic-entries]")?.value || 50000);
      const payload = await saveDiagnosticSettings(retentionDays, maxEntries);
      diagnosticSummary.settings = payload.settings;
      toast("诊断日志保留策略已保存");
      refreshDiagnostics({ keepPage: true });
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelector("[data-backup]")?.addEventListener("click", async () => {
    try {
      const blob = await downloadBackup();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `AutoVoucher备份_${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(url);
      persist("导出备份", "本地数据", "导出 SQLite 业务状态与原始文件归档");
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelector("[data-restore]")?.addEventListener("change", async (event) => {
    try {
      const file = event.target.files[0];
      if (!file) return;
      const preview = await previewServerBackup(file);
      const scope = preview.report.scope || {};
      const confirmed = window.confirm(
        `备份校验通过。\n公司：${preview.report.company || "未设置"}\n`
        + `业务事项：${scope.events || 0}；凭证：${scope.vouchers || 0}；原始资料：${scope.sourceDocuments || 0}\n`
        + "恢复将覆盖当前本地业务状态，是否继续？",
      );
      if (!confirmed) return;
      const payload = await restoreServerBackup(file);
      state = payload.state;
      render();
      toast("备份验证通过，数据已恢复");
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelector("[data-reset-demo]")?.addEventListener("click", async () => {
    const confirmation = window.prompt("该操作会先备份，再清除全部业务状态、原件归档和已知连接器密钥。请输入“备份并全量初始化”继续：", "");
    if (confirmation !== "备份并全量初始化") return;
    try {
      state = await resetState();
      route = "dashboard";
      window.history.replaceState({}, "", routeHash(route));
      render();
      toast("完整备份已生成，工作区已全量初始化");
    } catch (error) {
      toast(error.message, "warning");
    }
  });
}

function render() {
  app.innerHTML = shell();
  attachEvents();
}

route = routeFromHash();
if (!window.location.hash) window.history.replaceState({}, "", routeHash(route));
render();
if (route === "diagnostics") refreshDiagnostics();

window.addEventListener("popstate", () => {
  route = routeFromHash();
  render();
  if (route === "diagnostics") refreshDiagnostics();
  window.scrollTo({ top: 0, behavior: "instant" });
});

window.addEventListener("error", (event) => {
  reportClientDiagnostic({
    level: "ERROR",
    eventCode: "FRONTEND_RUNTIME_ERROR",
    message: event.message || "页面脚本发生错误",
    userAction: "刷新页面；如问题持续，请导出诊断包",
    operation: route,
    context: {
      route,
      filename: event.filename?.split("/").pop(),
      line: event.lineno,
      column: event.colno,
    },
    error: {
      name: event.error?.name,
      message: event.error?.message,
      stack: event.error?.stack,
    },
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportClientDiagnostic({
    level: "ERROR",
    eventCode: "FRONTEND_UNHANDLED_REJECTION",
    message: reason?.message || String(reason || "页面异步任务失败"),
    userAction: "重新执行当前操作；如问题持续，请导出诊断包",
    operation: route,
    context: { route },
    error: {
      name: reason?.name,
      message: reason?.message,
      stack: reason?.stack,
    },
  });
});

window.addEventListener("auto-voucher:sync-error", (event) => {
  reportClientDiagnostic({
    level: "ERROR",
    eventCode: "STATE_PERSIST_FAILED",
    message: event.detail || "业务状态持久化失败",
    userAction: "不要关闭页面；检查本地服务和磁盘空间后重试",
    operation: route,
    context: { route },
  });
});
