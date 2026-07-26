import "./styles.css";
import {
  buildLedger,
  applyVoucherLineEdits,
  createRuleFromVoucherEdit,
  createRuleVersion,
  createPurchaseVoucher,
  eligibleForBatchConfirmation,
  filterLocalRecords,
  formatMoney,
  matchingPostingRules,
  selectPostingRule,
  splitEventForPartialPayment,
  toCents,
  validateVoucher,
} from "./domain.js";
import {
  appendAudit,
  activateProduction,
  configureConnector,
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
  previewTargetTemplate,
  pushVoucherToConnector,
  queryExternalLedger,
  queryExternalReport,
  queryExternalVoucher,
  recheckExternalVoucher,
  resetState,
  reportClientDiagnostic,
  repairEnvironment,
  restoreServerBackup,
  saveConnectorSecret,
  saveDiagnosticSettings,
  saveState,
  runSetupPreflight,
  runEnvironmentCheck,
  runUpdateAction,
  syncConnectorApprovals,
  syncConnectorMasterData,
  testConnector,
  validateTargetTemplate,
} from "./store.js";

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
    auditLog: [],
    templateProfiles: [],
    readiness: {},
    productionActivation: { enabled: false },
  };
}
let route = "plan";
let expandedSection = null;
let pendingFiles = [];
let importResult = null;
let importPreview = null;
let importProgress = null;
let fieldMapping = {};
let mappingTemplateName = "";
let editingVoucherId = null;
let query = "";
let queryView = "vouchers";
let ruleEditorOpen = false;
let editingRuleId = null;
let connectorJob = null;
let selectedConnectorId = "kingdee-k3cloud";
let diagnosticResult = { items: [], total: 0, limit: 100, offset: 0, filters: { levels: [], categories: [] } };
let diagnosticSummary = { total: 0, byLevel: {}, byCategory: {}, settings: { retentionDays: 30, maxEntries: 50000 } };
let diagnosticFilters = { level: "", category: "", search: "", days: "7" };
let diagnosticPage = 0;
let diagnosticLoading = false;
const QUERY_RENDER_LIMIT = 100;

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
  ["amount", "含税金额", true],
  ["reference", "审批单号 / 单据号", false],
  ["department", "部门", false],
  ["project", "项目", false],
  ["summary", "摘要", false],
];

const routes = {
  plan: { label: "接入方案", icon: "link", path: "/setup/plan", section: "plan" },
  systems: { label: "系统与数据", icon: "tools", path: "/setup/systems", section: "systems" },
  rules: { label: "凭证规则", icon: "rules", path: "/setup/rules", section: "rules" },
  launch: { label: "测试上线", icon: "shield", path: "/setup/launch", section: "launch" },
  dashboard: { label: "凭证工作台", icon: "home", path: "/workspace", section: "workspace" },
  import: { label: "取数", icon: "upload", path: "/workspace/import", section: "workspace" },
  events: { label: "识别", icon: "briefcase", path: "/workspace/events", section: "workspace" },
  exceptions: { label: "识别异常", icon: "alert", path: "/workspace/exceptions", section: "workspace" },
  vouchers: { label: "生成及复核", icon: "voucher", path: "/workspace/vouchers", section: "workspace" },
  delivery: { label: "推送及状态", icon: "refresh", path: "/workspace/delivery", section: "workspace" },
  query: { label: "查询与审计", icon: "chart", path: "/workspace/query", section: "workspace" },
  connectors: { label: "连接器", icon: "link", path: "/workspace/connectors", section: "workspace" },
  ocr: { label: "OCR", icon: "scan", path: "/workspace/ocr", section: "workspace" },
  settings: { label: "通用设置", icon: "settings", path: "/workspace/settings", section: "workspace" },
  diagnostics: { label: "诊断日志", icon: "file", path: "/workspace/diagnostics", section: "workspace" },
  backup: { label: "备份与恢复", icon: "download", path: "/workspace/backup", section: "workspace" },
};

const primaryNavigation = [
  { key: "plan", label: "接入方案", icon: "link", route: "plan" },
  { key: "systems", label: "系统与数据", icon: "tools", route: "systems" },
  { key: "rules", label: "凭证规则", icon: "rules", route: "rules" },
  { key: "launch", label: "测试上线", icon: "shield", route: "launch" },
  { key: "workspace", label: "凭证工作台", icon: "voucher", route: "dashboard" },
];

const sectionNavigation = {
  workspace: [
    { route: "import", step: "01", label: "取数" },
    { route: "events", step: "02", label: "业务事项" },
    { route: "vouchers", step: "03", label: "凭证草稿与复核" },
    { route: "delivery", step: "04", label: "推送及状态" },
    { route: "query", step: "05", label: "查询与审计" },
    { route: "connectors", label: "连接器" },
    { route: "ocr", label: "OCR" },
    { route: "settings", label: "通用设置" },
    { route: "diagnostics", label: "诊断日志" },
    { route: "backup", label: "备份与恢复" },
  ],
};

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
  const path = window.location.hash.replace(/^#/, "") || "/setup/plan";
  return Object.entries(routes).find(([, item]) => item.path === path)?.[0] || "plan";
}

function routeHash(nextRoute) {
  return `#${routes[nextRoute]?.path || routes.plan.path}`;
}

function currentSection() {
  return routes[route]?.section || "plan";
}

function navigate(nextRoute, { replace = false } = {}) {
  if (!routes[nextRoute]) nextRoute = "plan";
  const nextHash = routeHash(nextRoute);
  if (window.location.hash !== nextHash) {
    window.history[replace ? "replaceState" : "pushState"]({}, "", nextHash);
  }
  route = nextRoute;
  expandedSection = sectionNavigation[routes[nextRoute].section]
    ? routes[nextRoute].section
    : null;
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
  const activeSection = currentSection();
  const pendingReviews = state.vouchers.filter((voucher) => voucher.status === "待审核").length;
  const pendingExceptions = state.exceptions.filter((exception) => exception.status === "待处理").length;
  return `
    <aside class="sidebar glass-panel">
      <div class="brand-row">
        <span class="brand-mark">${icon("arrow")}</span>
        <div><strong>Auto Voucher</strong><small>本地凭证工作台</small></div>
      </div>
      <p class="nav-label">工作空间</p>
      <nav class="side-nav" aria-label="主导航">
        ${primaryNavigation.map((item) => {
          const hasChildren = Boolean(sectionNavigation[item.key]);
          const isExpanded = expandedSection === item.key;
          const badge = item.key === "workspace" && (pendingReviews + pendingExceptions)
            ? `<b class="${pendingExceptions ? "warning-count" : ""}">${pendingReviews + pendingExceptions}</b>`
            : "";
          return `
          <button
            class="primary-nav-item ${activeSection === item.key ? "active" : ""} ${isExpanded ? "expanded" : ""}"
            data-route="${item.route}"
            ${hasChildren ? `aria-expanded="${isExpanded}" aria-controls="subnav-${item.key}"` : ""}
          >
            ${icon(item.icon)}<span>${item.label}</span>
            ${hasChildren
              ? `<span class="nav-trailing">${badge}<span class="nav-disclosure">${icon("chevron")}</span></span>`
              : badge}
          </button>
          ${hasChildren ? `
            <div
              id="subnav-${item.key}"
              class="side-subnav-shell ${isExpanded ? "expanded" : ""}"
              data-subnav-section="${item.key}"
              aria-hidden="${!isExpanded}"
              ${isExpanded ? "" : "inert"}
            >
              <div class="side-subnav" aria-label="${item.label}内部导航">
              ${sectionNavigation[item.key].map((child) => `
                <button
                  class="${child.step ? "with-step" : "plain"} ${route === child.route || (child.route === "events" && route === "exceptions") ? "active" : ""}"
                  data-route="${child.route}"
                >
                  ${child.step ? `<small>${child.step}</small>` : ""}<span>${child.label}</span>
                  ${child.route === "events" && pendingExceptions ? `<b class="warning-count">${pendingExceptions}</b>` : ""}
                  ${child.route === "vouchers" && pendingReviews ? `<b>${pendingReviews}</b>` : ""}
                </button>
              `).join("")}
              </div>
            </div>
          ` : ""}
        `;
        }).join("")}
      </nav>
      <div class="local-card">
        <span class="local-check">${icon("shield")}</span>
        <div><strong>本地数据已保护</strong><small>SQLite 与原件归档 · 自动持久化</small></div>
      </div>
    </aside>
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

function workflowModule({
  step,
  title,
  purpose,
  input,
  output,
  tools,
  route: target,
  iconName,
  value,
  unit,
  tone = "",
}) {
  return `
    <button
      class="workflow-module ${tone}"
      data-route="${target}"
      aria-label="${escapeHtml(`${step} ${title}，${purpose}，使用工具：${tools.join("、")}，进入${routes[target].label}`)}"
    >
      <span class="workflow-module-top">
        <span class="workflow-module-icon">${icon(iconName)}</span>
        <span class="workflow-step">${escapeHtml(step)}</span>
      </span>
      <span class="workflow-module-copy">
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(purpose)}</small>
      </span>
      <span class="workflow-io">
        <span><b>输入</b><i>${escapeHtml(input)}</i></span>
        <span><b>输出</b><i>${escapeHtml(output)}</i></span>
      </span>
      <span class="workflow-toolbox">
        <b>使用工具</b>
        <span>${tools.map((tool) => `<i>${escapeHtml(tool)}</i>`).join("")}</span>
      </span>
      <span class="workflow-module-status">
        <span><b>${escapeHtml(value)}</b><i>${escapeHtml(unit)}</i></span>
        <i>进入${escapeHtml(routes[target].label)} ${icon("arrow")}</i>
      </span>
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
          <input data-dimension-field="department" value="${escapeHtml(line.dimensions?.department || "")}" placeholder="部门" />
          <input data-dimension-field="project" value="${escapeHtml(line.dimensions?.project || "")}" placeholder="项目" />
          <input data-dimension-field="supplier" value="${escapeHtml(line.dimensions?.supplier || "")}" placeholder="供应商" />
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
  const labels = { ok: "环境正常", degraded: "部分能力不可用", blocked: "环境阻断" };
  const tone = environmentStatus.overallStatus === "ok"
    ? "success"
    : environmentStatus.overallStatus === "blocked" ? "warning" : "pending";
  return `
    <article class="settings-card glass-panel environment-card ${compact ? "compact" : ""}">
      <div class="panel-heading">
        <div><span class="eyebrow">运行环境</span><h2>环境检测</h2></div>
        <span class="status-pill ${tone}">${labels[environmentStatus.overallStatus] || "尚未检测"}</span>
      </div>
      <p>${issues.length
        ? `发现 ${issues.length} 项需要处理；阻断项未解决时不能启用生产。`
        : "核心程序、数据库、存储和安全依赖均已通过检测。"}</p>
      ${issues.length ? `<div class="environment-issue-list">${issues.slice(0, compact ? 3 : 8).map((item) => `
        <div><span class="environment-check-mark ${item.blocking ? "blocking" : ""}">${item.blocking ? "!" : "·"}</span><p><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.action)}</small></p></div>
      `).join("")}</div>` : ""}
      <div class="card-actions">
        <button class="secondary-button" data-check-environment>${icon("refresh")}重新检测环境</button>
        ${issues.some((item) => ["disk-space", "core-assets"].includes(item.id))
          ? `<button class="text-button" data-repair-environment="clear-update-cache">清理下载缓存</button>`
          : ""}
        ${issues.some((item) => item.id === "component-ocr")
          ? `<button class="text-button" data-repair-environment="reinstall-ocr" ${updateStatus.available ? "" : "disabled"}>安装 OCR 组件</button>`
          : ""}
        ${issues.some((item) => item.id === "component-pdf")
          ? `<button class="text-button" data-repair-environment="reinstall-pdf" ${updateStatus.available ? "" : "disabled"}>安装 PDF 组件</button>`
          : ""}
        ${compact ? "" : `<button class="text-button" data-repair-environment="recreate-shortcut" ${updateStatus.available ? "" : "disabled"}>重建桌面入口</button>`}
      </div>
      <small>支持编号 ${escapeHtml(environmentStatus.supportCode || "尚未生成")}</small>
    </article>
  `;
}

function updateCard() {
  const statusLabels = {
    launcher_unavailable: "未连接启动器",
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
    <article class="settings-card glass-panel update-card">
      <div class="panel-heading">
        <div><span class="eyebrow">轻量启动器</span><h2>版本与更新</h2></div>
        <span class="status-pill ${["idle", "ready"].includes(status) ? "success" : status === "error" ? "warning" : "pending"}">${statusLabels[status] || escapeHtml(status)}</span>
      </div>
      <div class="version-line"><span><small>当前版本</small><strong>${escapeHtml(updateStatus.currentVersion || runtimeStatus.coreVersion || "未知")}</strong></span>${updateStatus.availableVersion ? `<span><small>可用版本</small><strong>${escapeHtml(updateStatus.availableVersion)}</strong></span>` : ""}</div>
      ${["downloading", "ready"].includes(status) ? `<div class="update-progress"><i style="width:${progress}%"></i></div><small>下载进度 ${progress}%</small>` : ""}
      ${updateStatus.releaseNotes ? `<p>${escapeHtml(updateStatus.releaseNotes)}</p>` : `<p>${escapeHtml(updateStatus.message || "启动器负责校验、下载、版本切换和失败回退。")}</p>`}
      ${runtimeStatus.restartBlockers?.length ? `<div class="privacy-note warning">${icon("alert")}${runtimeStatus.restartBlockers.map(escapeHtml).join("；")}</div>` : ""}
      <div class="card-actions">
        <button class="secondary-button" data-update-action="check" ${!updateStatus.available ? "disabled" : ""}>${icon("refresh")}检查更新</button>
        ${["available", "security_required"].includes(status) ? `<button class="primary-button" data-update-action="download">下载更新</button>` : ""}
        ${status === "ready" ? `<button class="primary-button" data-update-action="apply" ${runtimeStatus.restartAllowed ? "" : "disabled"}>${icon("shield")}重启并更新</button>` : ""}
        ${["available", "ready"].includes(status) ? `<button class="text-button" data-update-action="postpone">稍后提醒</button>` : ""}
      </div>
    </article>
  `;
}

function planPage() {
  const enterprise = state.enterpriseProfiles?.[0] || {};
  const target = state.targetSystem || {};
  const sources = new Set((state.sourceSystems || []).map((item) => item.id));
  const scenarios = new Set(state.businessScenarios || []);
  const targets = setupCatalog?.targets || [];
  const sourceOptions = setupCatalog?.sources || [];
  return `
    <section class="page-heading">
      <div><span class="eyebrow">生产配置 · 第 1 级门槛</span><h1>接入方案</h1><p>先明确企业、目标 ERP、数据来源和业务场景，再由本地能力目录确定性生成完整数据流程。</p></div>
      <span class="status-pill ${gateStatus("plan").tone}">${gateStatus("plan").label}</span>
    </section>
    <form class="setup-layout" data-setup-plan>
      <article class="glass-panel setup-form-panel">
        <div class="panel-heading"><div><span class="eyebrow">企业与账套</span><h2>生产基础信息</h2></div></div>
        <div class="form-grid setup-form-grid">
          <label><span>企业名称 *</span><input name="name" required value="${escapeHtml(enterprise.name || "")}" /></label>
          <label><span>法人主体 *</span><input name="legalEntity" required value="${escapeHtml(enterprise.legalEntity || "")}" /></label>
          <label><span>账套 *</span><input name="accountSet" required value="${escapeHtml(enterprise.accountSet || "")}" /></label>
          <label><span>账簿 *</span><input name="ledger" required value="${escapeHtml(enterprise.ledger || "")}" /></label>
          <label><span>会计制度 *</span><input name="accountingStandard" required value="${escapeHtml(enterprise.accountingStandard || "")}" /></label>
          <label><span>本位币 *</span><input name="baseCurrency" required value="${escapeHtml(enterprise.baseCurrency || "CNY")}" /></label>
          <label><span>凭证字 *</span><input name="voucherType" required value="${escapeHtml(enterprise.voucherType || "")}" /></label>
          <label><span>操作者 *</span><input name="operator" required value="${escapeHtml(enterprise.operator || state.operator || "")}" /></label>
        </div>
        <div class="panel-heading setup-section-heading"><div><span class="eyebrow">凭证接收端</span><h2>目标 ERP</h2></div></div>
        <div class="form-grid setup-target-grid">
          <label><span>品牌 / 产品 *</span><select name="targetSystemId" required>
            <option value="">请选择</option>
            ${targets.map((item) => `<option value="${item.id}" ${target.id === item.id ? "selected" : ""}>${escapeHtml(`${item.brand} · ${item.product}`)}</option>`).join("")}
          </select></label>
          <label><span>版本 *</span><input name="targetVersion" required value="${escapeHtml(target.selectedVersion || "")}" placeholder="以客户实际版本为准" /></label>
          <label><span>部署方式 *</span><select name="deployment" required>
            ${["客户本地部署", "厂商云", "客户私有云"].map((item) => `<option ${target.deployment === item ? "selected" : ""}>${item}</option>`).join("")}
          </select></label>
        </div>
        <div class="setup-choice-group">
          <strong>数据来源 *</strong>
          <div class="setup-checks">${sourceOptions.map((item) => `<label><input type="checkbox" name="sourceSystemIds" value="${item.id}" ${sources.has(item.id) ? "checked" : ""} />${escapeHtml(`${item.brand} ${item.product}`)}</label>`).join("")}</div>
        </div>
        <div class="setup-choice-group">
          <strong>自动化业务场景 *</strong>
          <div class="setup-checks">${["费用报销", "采购付款", "销售收款", "资金划转"].map((item) => `<label><input type="checkbox" name="businessScenarios" value="${item}" ${scenarios.has(item) ? "checked" : ""} />${item}</label>`).join("")}</div>
        </div>
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

function systemsPage() {
  const target = state.targetSystem;
  const connectors = state.connectors || [];
  const template = (state.templateProfiles || []).find((item) => item.targetSystemId === target?.id);
  if (!target) {
    return `
      <section class="page-heading"><div><span class="eyebrow">生产配置 · 第 2 级门槛</span><h1>系统与数据</h1><p>可以先检查电脑环境与程序版本；ERP 配置需在接入方案之后进行。</p></div><button class="primary-button" data-route="plan">前往接入方案</button></section>
      <section class="settings-grid setup-system-grid">
        ${environmentCard({ compact: true })}
        ${updateCard()}
      </section>
      ${readonlyWorkspaceEmpty("尚未选择目标 ERP")}
    `;
  }
  return `
    <section class="page-heading">
      <div><span class="eyebrow">生产配置 · 第 2 级门槛</span><h1>系统与数据</h1><p>集中验证 API、文件模板、测试账套和目标基础资料。</p></div>
      <span class="status-pill ${gateStatus("systems").tone}">${gateStatus("systems").label}</span>
    </section>
    <section class="settings-grid setup-system-grid">
      ${environmentCard({ compact: true })}
      ${updateCard()}
      ${connectors.map((connector) => `<article class="settings-card glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">${connector.type === "finance" ? "目标系统" : "数据来源"}</span><h2>${escapeHtml(connector.name)}</h2></div><span class="status-pill ${connector.status === "connected" ? "success" : "warning"}">${connector.status === "connected" ? "测试通过" : connector.status === "error" ? "配置失效" : "待测试"}</span></div>
        <p>${escapeHtml(connector.environment || "测试环境")} · ${escapeHtml(connector.adapter)}</p>
        <button class="secondary-button" data-open-connector="${connector.id}">${icon("link")}配置与测试</button>
      </article>`).join("")}
      <article class="settings-card glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">基础资料</span><h2>目标主数据</h2></div><b>${state.masterData?.length || 0} 条</b></div>
        <p>科目、供应商、客户、部门、项目、员工、成本中心、币种、税码和现金流量项目。</p>
        <button class="secondary-button" data-route="import">${icon("upload")}导入基础资料</button>
      </article>
      <article class="settings-card glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">模板路径</span><h2>ERP 模板档案</h2></div><span class="status-pill ${template?.testImportStatus === "passed" ? "success" : "warning"}">${template?.testImportStatus === "passed" ? "测试导入通过" : "待验证"}</span></div>
        <p>${template ? escapeHtml(`${template.name} · v${template.version}`) : "上传客户提供的空白模板或成功样例，建立表头指纹和必填列档案。"}</p>
        <label class="secondary-button file-label">${icon("upload")}选择模板<input data-target-template type="file" accept=".csv,.xlsx" hidden /></label>
      </article>
    </section>
  `;
}

function launchPage() {
  const gates = ["plan", "systems", "rules", "production"];
  const enterprise = state.enterpriseProfiles?.[0] || {};
  const canActivate = ["plan", "systems", "rules"].every(
    (name) => state.readiness?.[name]?.status === "ready",
  ) && !(environmentStatus.checks || []).some(
    (item) => item.productionBlocking && item.status !== "passed",
  );
  return `
    <section class="page-heading">
      <div><span class="eyebrow">生产配置 · 第 4 级门槛</span><h1>测试上线</h1><p>测试写入仅允许测试账套；连接器只保存草稿，绝不自动提交、审核、过账或结账。</p></div>
      <button class="secondary-button" data-run-setup-preflight>${icon("shield")}重新检查</button>
    </section>
    <section class="launch-grid">
      <article class="glass-panel launch-gates">
        <div class="panel-heading"><div><span class="eyebrow">四级门槛</span><h2>上线就绪状态</h2></div></div>
        ${gates.map((name, index) => {
          const gate = gateStatus(name);
          const labels = ["方案", "系统", "规则", "生产"];
          return `<div class="launch-gate"><b>${index + 1}</b><div><strong>${labels[index]}</strong><p>${(gate.reasons || []).map(escapeHtml).join("；") || "验证通过"}</p></div><span class="status-pill ${gate.tone}">${gate.label}</span></div>`;
        }).join("")}
        <div class="launch-evidence">
          <strong>真实测试证据</strong>
          ${[
            ["permissionChecked", "最小权限账号与权限不足路径已验证"],
            ["periodChecked", "测试账套期间检查已通过"],
            ["testDraftSaved", "测试账套已成功保存凭证草稿"],
            ["voucherRechecked", "已回查取得真实外部凭证编号"],
            ["idempotencyChecked", "重复幂等请求不会创建第二张凭证"],
            ["shadowRunChecked", "影子运行结果已与人工结果核对"],
            ["financeConfirmed", "财务负责人已确认测试结果"],
          ].map(([key, label]) => `<label class="check-row"><input type="checkbox" data-launch-evidence="${key}" ${state.launchEvidence?.[key] ? "checked" : ""} />${label}</label>`).join("")}
        </div>
      </article>
      <form class="glass-panel activation-panel" data-activate-production>
        <div class="panel-heading"><div><span class="eyebrow">再次确认</span><h2>启用生产</h2></div></div>
        <label><span>目标公司</span><input name="company" value="${escapeHtml(enterprise.legalEntity || "")}" /></label>
        <label><span>账套</span><input name="accountSet" value="${escapeHtml(enterprise.accountSet || "")}" /></label>
        <label><span>账簿</span><input name="ledger" value="${escapeHtml(enterprise.ledger || "")}" /></label>
        <label><span>环境</span><input name="environment" value="生产环境" /></label>
        <label><span>单批上限</span><input name="batchLimit" type="number" min="1" max="1000" value="${state.productionActivation?.batchLimit || 50}" /></label>
        <button
          class="primary-button"
          type="submit"
          ${state.productionActivation?.enabled || !canActivate ? "disabled" : ""}
          title="${!canActivate ? "方案、系统和规则门槛全部通过后才能启用生产" : ""}"
        >${icon("shield")}${state.productionActivation?.enabled ? "生产已启用" : "确认并启用生产"}</button>
      </form>
    </section>
  `;
}

function readonlyWorkspaceEmpty(message) {
  return `<section class="glass-panel readonly-workspace"><div class="empty-state">${icon("shield")}<h3>${escapeHtml(message)}</h3><p>工作台保持只读，不会生成、导出或推送任何凭证。</p><button class="primary-button" data-route="plan">完成接入方案</button></div></section>`;
}

function dashboardPage() {
  if (state.readiness?.plan?.status !== "ready") {
    return `<section class="page-heading"><div><span class="eyebrow">生产工作区</span><h1>凭证工作台</h1><p>完成接入方案后才能开始处理真实业务资料。</p></div></section>${readonlyWorkspaceEmpty("接入方案尚未完成")}`;
  }
  const pendingReview = state.vouchers.filter((item) => item.status === "待审核").length;
  const pushed = state.vouchers.filter((item) => item.status === "已推送").length;
  const sceneCount = new Set(state.events.map((item) => item.type)).size;
  const workflowModules = [
    {
      step: "01",
      title: "取数",
      purpose: "把分散在文件与业务系统中的原始资料安全取回本地。",
      input: "发票、流水、报销单、基础资料",
      output: "已归档的标准数据源",
      tools: ["文件 / 文件夹", "CSV · XLSX · XML", "PDF · 图片", "SHA-256 去重"],
      route: "import",
      iconName: "upload",
      value: state.sourceDocuments.length,
      unit: "份数据源",
    },
    {
      step: "02",
      title: "场景",
      purpose: "先确定要处理的业务场景，再组织所需字段、资料与规则。",
      input: "数据源 + 业务目标",
      output: "场景化处理任务",
      tools: ["采购付款模板", "字段映射", "基础资料版本", "事项合并"],
      route: "rules",
      iconName: "rules",
      value: sceneCount,
      unit: "个业务场景",
    },
    {
      step: "03",
      title: "识别",
      purpose: "从场景资料中识别日期、客商、金额及单据关联关系。",
      input: "场景化处理任务",
      output: "业务事项 + 待确认异常",
      tools: ["结构化解析", "PDF 文本提取", "本地 OCR", "异常检测"],
      route: "events",
      iconName: "briefcase",
      value: state.events.length,
      unit: "项业务事项",
    },
    {
      step: "04",
      title: "生成及复核",
      purpose: "生成可解释的凭证草稿，由财务人员复核后确认。",
      input: "业务事项 + 科目规则",
      output: "已确认的凭证",
      tools: ["确定性规则", "借贷平衡校验", "分录编辑", "人工确认"],
      route: "vouchers",
      iconName: "voucher",
      value: state.vouchers.length,
      unit: `张草稿 · ${pendingReview} 待审`,
      tone: pendingReview ? "attention" : "success",
    },
    {
      step: "05",
      title: "推送及状态",
      purpose: "将确认结果安全推送到财务系统，并持续回查最终状态。",
      input: "已确认的凭证",
      output: "外部凭证号 + 最终状态",
      tools: ["幂等键", "财务连接器", "外部编号回查", "推送状态机"],
      route: "delivery",
      iconName: "link",
      value: pushed,
      unit: "张完成回查",
      tone: pushed ? "success" : "",
    },
  ];
  return `
    <section class="page-heading workflow-heading">
      <div>
        <span class="eyebrow">凭证自动化 · 五段能力链路</span>
        <h1>五个模块，完成一张凭证</h1>
        <p>${escapeHtml(state.operator)}，从取数到状态回查；点击模块即可进入对应工作页面。</p>
      </div>
      <div class="workflow-heading-actions">
        <span>${icon("shield")}数据只在本机处理</span>
        <button class="primary-button" data-route="import">${icon("plus")}开始导入</button>
      </div>
    </section>
    <section class="workflow-mainline" aria-label="凭证自动化五模块">
      ${workflowModules.map((module) => workflowModule(module)).join("")}
    </section>
  `;
}

function importPage() {
  return `
    <section class="page-heading">
      <div><span class="eyebrow">P0 本地文件闭环</span><h1>导入业务数据</h1><p>文件由本机服务解析并归档；导入前可确认字段，内容哈希重复时不会创建第二份资料。</p></div>
      <div class="heading-actions">
        <button class="secondary-button" data-download-master-template>${icon("download")}基础资料模板</button>
        <button class="secondary-button" data-download-template>${icon("download")}业务数据模板</button>
      </div>
    </section>
    <section class="import-grid">
      <article class="drop-panel glass-panel">
        <input id="file-input" type="file" multiple accept=".csv,.xml,.xbrl,.ofd,.xlsx,.pdf,.png,.jpg,.jpeg" hidden />
        <input id="folder-input" type="file" multiple webkitdirectory directory hidden />
        <div class="drop-zone" data-drop-zone>
          <span>${icon("upload")}</span>
          <h2>拖入文件，或点击选择</h2>
          <p>CSV、XLSX 和通用字段型 XML 可直接生成事项；PDF 与图片先安全归档，再由本地 OCR 生成候选字段供人工确认。</p>
          <div class="drop-actions"><button class="primary-button" data-choose-files>选择文件</button><button class="secondary-button" data-choose-folder>选择文件夹</button></div>
        </div>
        <div class="privacy-note">${icon("shield")}不会上传云端；文本型 PDF 本地提取，扫描件和图片由本地 OCR 生成候选并等待人工确认。</div>
      </article>
      <article class="preview-panel glass-panel import-preview">
        <div class="panel-heading"><div><span class="eyebrow">导入预览</span><h2>${pendingFiles.length ? `${pendingFiles.length} 个文件待确认` : "等待选择文件"}</h2></div></div>
        ${pendingFiles.length ? `
          <div class="file-list">
            ${pendingFiles.map((item, index) => `
              <div><span class="file-icon">${icon("file")}</span><p><strong>${escapeHtml(item.file.name)}</strong><small>${item.kind} · ${(item.file.size / 1024).toFixed(1)} KB · ${item.action}</small></p><button data-remove-file="${index}" aria-label="移除">${icon("close")}</button></div>
            `).join("")}
          </div>
          ${importPreview ? `
            <div class="mapping-card">
              <div class="mapping-heading">
                <div><strong>${importPreview.kind === "masterData" ? "确认基础资料" : "确认字段映射"}</strong><small>${importPreview.kind === "masterData"
                  ? `识别到 ${importPreview.masterDataCount} 条科目 / 客商 / 辅助核算资料`
                  : importPreview.matchedTemplate
                  ? `已匹配模板：${escapeHtml(importPreview.matchedTemplate.name)}`
                  : `识别到 ${importPreview.headers.length} 个源字段`}</small></div>
                <span>${escapeHtml(importPreview.filename)}</span>
              </div>
              ${importPreview.kind !== "masterData" ? `<div class="mapping-grid">
                ${mappingFields.map(([key, label, required]) => `
                  <label><span>${label}${required ? " *" : ""}</span>
                    <select data-mapping-field="${key}">
                      <option value="">不导入</option>
                      ${importPreview.headers.map((header) => `
                        <option value="${escapeHtml(header)}" ${fieldMapping[key] === header ? "selected" : ""}>${escapeHtml(header)}</option>
                      `).join("")}
                    </select>
                  </label>
                `).join("")}
              </div>
              <label class="template-name"><span>模板名称（选填）</span><input data-template-name value="${escapeHtml(mappingTemplateName)}" placeholder="例如：招商银行流水 2026" /></label>` : ""}
              <div class="sample-table">
                <div class="sample-row sample-head">${importPreview.headers.slice(0, 4).map((header) => `<span>${escapeHtml(header)}</span>`).join("")}</div>
                ${importPreview.sampleRows.slice(0, 3).map((row) => `
                  <div class="sample-row">${importPreview.headers.slice(0, 4).map((header) => `<span>${escapeHtml(row[header] ?? "")}</span>`).join("")}</div>
                `).join("")}
              </div>
            </div>
          ` : ""}
          ${importProgress ? `
            <div class="job-progress">
              <div><strong>${importProgress.status === "queued" ? "正在排队" : "正在本地处理"}</strong><span>${importProgress.progress?.percent || 0}%</span></div>
              <progress max="100" value="${importProgress.progress?.percent || 0}"></progress>
              <small>${escapeHtml(importProgress.progress?.currentFile || "准备任务")} · ${importProgress.progress?.processed || 0}/${importProgress.progress?.total || pendingFiles.length}</small>
            </div>
          ` : ""}
          <button class="primary-button full-button" data-run-import ${importProgress ? "disabled" : ""}>${icon("check")}${importProgress ? "处理中…" : "确认并开始导入"}</button>
        ` : `<div class="empty-state">${icon("file")}<p>选择文件后将在这里显示类型、大小和预计处理方式。</p></div>`}
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

function eventsPage() {
  const filtered = filterLocalRecords(
    state.events,
    query,
    ["type", "counterparty", "reference", "status", "amountCents", "date", "company", "invoiceNo", "bankSerial"],
    QUERY_RENDER_LIMIT,
  );
  const selected = getSelectedEvent();
  return `
    <section class="page-heading compact">
      <div><span class="eyebrow">资料关系与追溯</span><h1>业务事项</h1><p>${filtered.length} 项本地业务记录</p></div>
      <div class="heading-actions">
        ${state.exceptions.some((item) => item.status === "待处理")
          ? `<button class="secondary-button" data-route="exceptions">${icon("alert")}处理识别异常</button>`
          : ""}
        <button class="primary-button" data-route="import">${icon("plus")}继续取数</button>
      </div>
    </section>
    <section class="master-detail">
      <article class="master-list glass-panel">
        ${filtered.map((event) => eventRow(event, true)).join("") || `<div class="empty-state">没有匹配的业务事项</div>`}
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
  const deliverable = state.vouchers.filter((voucher) =>
    ["已确认", "推送中", "状态待确认", "已推送", "推送失败"].includes(voucher.status));
  const connectedTarget = state.connectors.find((connector) =>
    connector.id === state.activeFinanceConnectorId);
  const completed = deliverable.filter((voucher) => voucher.status === "已推送").length;
  const attention = deliverable.filter((voucher) =>
    ["状态待确认", "推送失败"].includes(voucher.status)).length;
  return `
    <section class="page-heading compact">
      <div>
        <span class="eyebrow">自动化 · 第 5 步</span>
        <h1>推送及状态</h1>
        <p>只推送已经人工确认的凭证，并保留目标系统编号、回查结果和失败原因。</p>
      </div>
      <div class="heading-actions">
        <button class="secondary-button" data-route="connectors">${icon("link")}配置连接器</button>
        <button class="primary-button" data-route="query">${icon("chart")}查询外部结果</button>
      </div>
    </section>
    <section class="delivery-summary">
      <article class="glass-panel"><span>当前推送目标</span><strong>${escapeHtml(connectedTarget?.name || "尚未配置")}</strong><small>${escapeHtml(connectedTarget?.environment || "请先在工具中配置连接器")}</small></article>
      <article class="glass-panel"><span>待推送或处理中</span><strong>${deliverable.length - completed}</strong><small>张凭证</small></article>
      <article class="glass-panel success"><span>已完成回查</span><strong>${completed}</strong><small>张凭证</small></article>
      <article class="glass-panel ${attention ? "attention" : ""}"><span>需要关注</span><strong>${attention}</strong><small>张凭证</small></article>
    </section>
    <section class="delivery-list glass-panel">
      <div class="panel-heading">
        <div><span class="eyebrow">推送队列</span><h2>凭证状态</h2></div>
        <small>连接器配置已移至“工具”</small>
      </div>
      ${deliverable.length ? deliverable.map((voucher) => {
        const validation = validateVoucher(voucher);
        return `
          <article class="delivery-row">
            <button class="delivery-main" data-open-voucher="${voucher.sourceEventIds[0]}">
              <span><strong>${escapeHtml(voucher.number)}</strong><small>${escapeHtml(voucher.summary)} · ${voucher.accountingDate}</small></span>
              <strong>${formatMoney(validation.debitCents)}</strong>
              <span class="status-pill ${statusTone(voucher.status)}">${escapeHtml(voucher.status)}</span>
            </button>
            <div class="delivery-action">
              ${voucher.externalReference ? `<small>外部编号 ${escapeHtml(voucher.externalReference)}</small>` : ""}
              ${voucher.status === "已确认" ? `<button class="primary-button" data-push="${voucher.id}">${icon("arrow")}推送并回查</button>` : ""}
              ${voucher.status === "状态待确认" ? `<button class="secondary-button" data-recheck="${voucher.id}">${icon("refresh")}再次回查</button>` : ""}
            </div>
          </article>
        `;
      }).join("") : `
        <div class="empty-state">${icon("voucher")}<p>暂无可推送凭证。请先在“生成及复核”中完成审核。</p><button class="secondary-button" data-route="vouchers">进入生成及复核</button></div>
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

function rulesPage() {
  const editingRule = editingRuleId
    ? state.rules.find((rule) => rule.id === editingRuleId)
    : null;
  const formRule = editingRule || {
    name: "",
    priority: 70,
    match: { businessType: "采购付款", counterparty: "" },
    posting: {
      debitAccountCode: "",
      debitAccountName: "",
      creditAccountCode: "",
      creditAccountName: "",
    },
  };
  return `
    <section class="page-heading">
      <div><span class="eyebrow">确定性优先</span><h1>规则管理</h1><p>企业明确规则优先于历史映射和 AI 建议；每张凭证持续引用生成时的规则版本。</p></div>
      <button class="primary-button" data-add-rule>${icon("plus")}${ruleEditorOpen ? "收起编辑器" : "新建规则"}</button>
    </section>
    ${ruleEditorOpen ? `
      <section class="rule-editor glass-panel">
        <div class="panel-heading"><div><span class="eyebrow">${editingRule ? `从 v${escapeHtml(editingRule.version)} 创建新版本` : "创建规则版本"}</span><h2>${editingRule ? `修改 ${escapeHtml(editingRule.name)}` : "新建确定性规则"}</h2></div></div>
        <div class="rule-form">
          <label><span>规则名称 *</span><input data-rule-name value="${escapeHtml(formRule.name)}" placeholder="例如：华东供应商库存商品规则" /></label>
          <label><span>优先级 *</span><input data-rule-priority type="number" min="1" max="999" value="${formRule.priority}" /></label>
          <label><span>业务类型 *</span><select data-rule-business-type>${["采购付款", "差旅报销", "销售收款", "员工薪酬"].map((value) => `<option value="${value}" ${formRule.match?.businessType === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
          <label><span>限定供应商 / 客商</span><input data-rule-counterparty value="${escapeHtml(formRule.match?.counterparty || "")}" placeholder="留空表示该业务类型全部适用" /></label>
          <label><span>借方科目编码 *</span><input data-rule-debit-code value="${escapeHtml(formRule.posting?.debitAccountCode)}" /></label>
          <label><span>借方科目名称 *</span><input data-rule-debit-name value="${escapeHtml(formRule.posting?.debitAccountName)}" /></label>
          <label><span>贷方科目编码 *</span><input data-rule-credit-code value="${escapeHtml(formRule.posting?.creditAccountCode)}" /></label>
          <label><span>贷方科目名称 *</span><input data-rule-credit-name value="${escapeHtml(formRule.posting?.creditAccountName)}" /></label>
        </div>
        <div class="rule-editor-actions"><button class="quiet-button" data-cancel-rule>取消</button><button class="primary-button" data-save-rule>${icon("check")}${editingRule ? "保存待确认新版本" : "保存为待启用 v1.0"}</button></div>
      </section>
    ` : ""}
    <section class="rules-list">
      ${state.rules.length ? state.rules.map((rule) => `
        <article class="rule-card glass-panel">
          <div class="rule-priority">${rule.priority}</div>
          <div><span class="eyebrow">版本 ${rule.version}${rule.supersededAt ? " · 历史版本" : rule.status === "待启用" ? " · 待启用" : ""}</span><h2>${escapeHtml(rule.name)}</h2><p><strong>条件：</strong>${escapeHtml(rule.condition)}</p><p><strong>动作：</strong>${escapeHtml(rule.action)}</p>${rule.supersedesRuleId ? `<p class="muted-copy">继承自 ${escapeHtml(rule.supersedesRuleId)}</p>` : ""}</div>
          <div class="rule-card-actions">
            ${!rule.supersededAt ? `<button class="text-button" data-edit-rule="${rule.id}">创建新版本</button>` : ""}
            <button class="toggle ${rule.enabled ? "on" : ""}" data-toggle-rule="${rule.id}" aria-label="切换规则" ${rule.supersededAt ? "disabled" : ""}><i></i></button>
          </div>
        </article>
      `).join("") : `
        <article class="glass-panel readonly-workspace">
          <div class="empty-state">${icon("rules")}<h3>尚无凭证规则</h3><p>规则不会预填借贷科目。请根据客户科目表和辅助核算要求创建，人工确认后再启用。</p></div>
        </article>
      `}
    </section>
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
  const isKingdee = connector.adapter === "kingdee-k3cloud-webapi-v6";
  const isConfiguredVendor = ["yonyou-u8-openapi-v12", "inspur-gscloud-igix"].includes(connector.adapter);
  const statusLabel = {
    connected: "测试通过",
    configured: "待测试",
    error: "配置失效",
    not_configured: "未配置",
  }[connector.status] || "未配置";
  const probeChecks = (connector.lastProbe?.checks || []).map((item) => `<li class="${item.status}"><span>${item.status === "passed" ? icon("check") : icon("alert")}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.detail)}</small></div></li>`).join("");
  return `
    <section class="page-heading compact connector-page-heading">
      <div><h1>连接器</h1><p>只配置真实客户系统；密钥仅保存到操作系统密钥库。</p></div>
    </section>
    ${connectorJob ? `<div class="job-progress"><div><strong>后台同步任务</strong><span>${connectorJob.status}</span></div><progress max="100" value="${connectorJob.progress?.percent || 20}"></progress></div>` : ""}
    <section class="connector-workspace glass-panel">
      <aside class="connector-catalog">
        <div class="connector-catalog-heading"><strong>真实系统</strong><small>${connectorItems.length} 个配置</small></div>
        <div class="connector-catalog-list">${connectorItems.map((item) => `<button class="${item.id === connector.id ? "active" : ""}" data-select-connector="${item.id}"><span class="connector-list-icon">${icon(item.type === "finance" ? "voucher" : "briefcase")}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.environment)} · ${escapeHtml(item.adapter)}</small></span><span class="connector-state ${item.status === "connected" ? "success" : item.status === "error" ? "warning" : "pending"}"><i></i>${item.status === "connected" ? "测试通过" : "待配置"}</span></button>`).join("")}</div>
      </aside>
      <article class="connector-detail">
        <header class="connector-detail-header">
          <div class="connector-detail-identity"><span class="connector-detail-icon">${icon(connector.type === "finance" ? "voucher" : "briefcase")}</span><div><div class="connector-detail-meta"><span>${connector.type === "finance" ? "目标 ERP" : "数据来源"}</span><span>${escapeHtml(connector.environment)}</span><span class="connector-state ${connector.status === "connected" ? "success" : "pending"}"><i></i>${statusLabel}</span></div><h2>${escapeHtml(connector.name)}</h2><p>${isFeishu ? "只接收状态明确为 APPROVED 的审批实例。" : "只保存凭证草稿并回查真实外部编号；不提交、审核或过账。"}</p></div></div>
          <div class="connector-header-actions"><button class="secondary-button" data-test-real="${connector.id}">${icon("refresh")}测试连接</button><button class="primary-button" data-save-connector="${connector.id}">${icon("check")}保存配置</button></div>
        </header>
        <form class="connector-form connector-detail-form" data-connector-form="${connector.id}">
          <section class="connector-config-section">
            <div class="connector-section-heading"><div><h3>连接与环境</h3><p>测试账套与生产账套必须分别配置和验证。</p></div></div>
            <div class="connector-field-grid">
              ${isFeishu ? `
                <label><span>App ID</span><input name="appId" value="${escapeHtml(connector.appId || "")}" required /></label>
                <label><span>App Secret（系统密钥库）</span><input name="secret" type="password" autocomplete="new-password" /></label>
                <label><span>审批定义 Code</span><input name="approvalCode" value="${escapeHtml(connector.approvalCode || "")}" required /></label>
              ` : `
                <label><span>API 地址</span><input name="baseUrl" value="${escapeHtml(connector.baseUrl || "")}" placeholder="https://..." required /></label>
                <label><span>账套 / 数据中心 ID</span><input name="accountId" value="${escapeHtml(connector.accountId || "")}" required /></label>
                <label><span>专用集成用户</span><input name="username" value="${escapeHtml(connector.username || "")}" required /></label>
                <label><span>${isKingdee ? "密码" : "访问令牌"}（系统密钥库）</span><input name="secret" type="password" autocomplete="new-password" /></label>
                <label><span>账簿</span><input name="ledger" value="${escapeHtml(connector.ledger || "")}" required /></label>
              `}
              <label><span>环境</span><select name="environment"><option ${connector.environment === "测试环境" ? "selected" : ""}>测试环境</option><option ${connector.environment === "生产环境" ? "selected" : ""}>生产环境</option></select></label>
            </div>
          </section>
          <section class="connector-config-section">
            <label class="check-row connector-permission-row"><input name="leastPrivilegeConfirmed" type="checkbox" ${connector.leastPrivilegeConfirmed ? "checked" : ""} />使用专用最小权限账号，并确认连接器没有提交、审核、过账或结账权限</label>
          </section>
          ${isFeishu ? `<section class="connector-config-section"><div class="connector-section-heading"><div><h3>审批字段映射</h3><p>控件 ID 必须来自客户实际审批定义。</p></div></div><div class="connector-field-grid"><label><span>业务日期</span><input name="mapDate" value="${escapeHtml(connector.fieldMapping?.date || "")}" /></label><label><span>供应商 / 客商</span><input name="mapCounterparty" value="${escapeHtml(connector.fieldMapping?.counterparty || "")}" /></label><label><span>金额</span><input name="mapAmount" value="${escapeHtml(connector.fieldMapping?.amount || "")}" /></label><label><span>审批单号</span><input name="mapReference" value="${escapeHtml(connector.fieldMapping?.reference || "")}" /></label></div></section>` : ""}
          ${isConfiguredVendor ? `<section class="connector-config-section"><div class="connector-section-heading"><div><h3>版本化接口模型</h3><p>必须粘贴客户官方接口包对应的端点、字段和辅助核算映射；系统不会猜测厂商字段。</p></div></div><div class="connector-field-grid"><label class="wide-field"><span>端点配置 JSON</span><textarea name="endpointProfile" rows="8">${escapeHtml(JSON.stringify(connector.endpointProfile || {}, null, 2))}</textarea></label><label class="wide-field"><span>字段配置 JSON</span><textarea name="fieldProfile" rows="8">${escapeHtml(JSON.stringify(connector.fieldProfile || {}, null, 2))}</textarea></label><label class="wide-field"><span>辅助核算字段映射 JSON</span><textarea name="dimensionFieldMap" rows="5">${escapeHtml(JSON.stringify(connector.dimensionFieldMap || {}, null, 2))}</textarea></label></div></section>` : ""}
          ${isKingdee ? `<section class="connector-config-section"><div class="connector-section-heading"><div><h3>金蝶辅助核算映射</h3><p>所有实际维度必须映射到目标字段，否则推送预检失败。</p></div></div><label class="wide-field"><span>辅助核算字段映射 JSON</span><textarea name="dimensionFieldMap" rows="5">${escapeHtml(JSON.stringify(connector.dimensionFieldMap || {}, null, 2))}</textarea></label></section>` : ""}
          ${probeChecks ? `<section class="connector-config-section"><div class="connector-section-heading"><div><h3>最近连接检查</h3></div></div><ul class="probe-checks connector-probe-list">${probeChecks}</ul></section>` : ""}
        </form>
        <footer class="connector-detail-footer"><p>${icon("shield")}任何系统均只保存草稿，不自动提交、审核或过账。</p><div>${isFeishu ? `<button class="secondary-button" data-sync-approvals="${connector.id}" ${connector.status !== "connected" ? "disabled" : ""}>同步已审批单据</button>` : `<button class="secondary-button" data-sync-master="${connector.id}" ${connector.status !== "connected" ? "disabled" : ""}>同步基础资料</button>`}<button class="quiet-button" data-activate-${isFeishu ? "workflow" : "finance"}="${connector.id}">设为当前${isFeishu ? "来源" : "目标"}</button></div></footer>
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
    result[item.categoryLabel] = (result[item.categoryLabel] || 0) + 1;
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
    launch: launchPage,
    dashboard: dashboardPage,
    import: importPage,
    events: eventsPage,
    vouchers: vouchersPage,
    delivery: deliveryPage,
    exceptions: exceptionsPage,
    query: queryPage,
    rules: rulesPage,
    connectors: connectorsPage,
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
    <div class="app-shell">
      ${sidebar()}
      <main class="content">
        <div class="global-search-anchor">${globalSearchBox()}</div>
        ${currentPage()}
      </main>
    </div>
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
  if (extension === "xml") return { kind: "结构化 XML", action: "归档并提取基础元数据" };
  if (extension === "xlsx") return { kind: "Excel", action: "解析字段并创建业务事项" };
  if (extension === "xls") return { kind: "旧版 Excel", action: "不支持" };
  if (extension === "pdf") return { kind: "PDF", action: "归档并尝试提取文本" };
  if (["png", "jpg", "jpeg"].includes(extension)) return { kind: "图片", action: "本地 OCR 生成候选并等待人工确认" };
  return { kind: "未知格式", action: "不支持" };
}

async function addFiles(files) {
  pendingFiles = [...pendingFiles, ...[...files].map((file) => ({ file, ...fileKind(file.name) }))];
  importPreview = null;
  fieldMapping = {};
  mappingTemplateName = "";
  render();
  if (pendingFiles.length === 1 && /\.(csv|xlsx)$/i.test(pendingFiles[0].file.name)) {
    try {
      importPreview = await previewImportFile(pendingFiles[0].file);
      fieldMapping = { ...importPreview.suggestedMapping };
      mappingTemplateName = importPreview.matchedTemplate?.name || "";
      render();
    } catch (error) {
      toast(`无法预览字段：${error.message}`, "warning");
    }
  }
}

async function runImport() {
  if (!pendingFiles.length) return;
  if (importPreview?.kind !== "masterData" && importPreview && (!fieldMapping.counterparty || !fieldMapping.amount)) {
    toast("请先映射“供应商/客商”和“含税金额”字段", "warning");
    return;
  }
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
  if (!rule) throw new Error("未命中已启用的完整凭证规则");
  const voucher = createPurchaseVoucher(event, state.vouchers.length + 1, rule);
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
        title: `${event.reference} 尚无可用凭证规则`,
        detail: "系统未使用采购付款默认科目，也不会猜测借贷分录。",
        suggestion: "在“凭证规则”中配置科目、辅助核算和审批依据并经人工确认后启用。",
        status: "待处理",
      });
      event.exceptionIds ||= [];
      event.exceptionIds.push(exceptionId);
    }
    event.status = "待处理";
    persist("创建待配置事项", event.reference, "未命中已启用的完整凭证规则，未生成凭证草稿");
    toast("未生成凭证：请先完成并启用凭证规则", "warning");
    return;
  }
  state.vouchers.unshift(voucher);
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
      const dimension = (name) => dimensions?.querySelector(`[data-dimension-field="${name}"]`)?.value.trim() || "";
      return {
        ...voucher.lines[index],
        lineNo: index + 1,
        summary: field("summary"),
        accountCode: field("accountCode"),
        accountName: field("accountName"),
        debitCents: toCents(field("debit") || "0"),
        creditCents: toCents(field("credit") || "0"),
        dimensions: {
          department: dimension("department") || null,
          project: dimension("project") || null,
          supplier: dimension("supplier") || null,
        },
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
      return toast(`推送前校验未通过：${failed.map((item) => item.name).join("、")}`, "warning");
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
  if (connector.adapter === "feishu-approval-v4") {
    config = {
      appId: String(values.appId || "").trim(),
      approvalCode: String(values.approvalCode || "").trim(),
      environment: values.environment,
      leastPrivilegeConfirmed: values.leastPrivilegeConfirmed === "on",
      fieldMapping: {
        date: String(values.mapDate || "").trim(),
        counterparty: String(values.mapCounterparty || "").trim(),
        amount: String(values.mapAmount || "").trim(),
        reference: String(values.mapReference || "").trim(),
      },
    };
    secretName = "app_secret";
  } else {
    config = {
      baseUrl: String(values.baseUrl || "").trim().replace(/\/+$/, ""),
      accountId: String(values.accountId || "").trim(),
      username: String(values.username || "").trim(),
      ledger: String(values.ledger || "").trim(),
      environment: values.environment,
      leastPrivilegeConfirmed: values.leastPrivilegeConfirmed === "on",
    };
    try {
      config.dimensionFieldMap = JSON.parse(String(values.dimensionFieldMap || "{}"));
      if (connector.adapter !== "kingdee-k3cloud-webapi-v6") {
        config.endpointProfile = JSON.parse(String(values.endpointProfile || "{}"));
        config.fieldProfile = JSON.parse(String(values.fieldProfile || "{}"));
      }
    } catch {
      return toast("端点、字段或辅助核算配置必须是有效 JSON", "warning");
    }
    secretName = connector.adapter === "kingdee-k3cloud-webapi-v6" ? "password" : "access_token";
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
  } catch (error) {
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

function attachEvents() {
  document.querySelector("[data-reload-app]")?.addEventListener("click", () => window.location.reload());
  document.querySelectorAll("[data-section-toggle]").forEach((element) => {
    element.addEventListener("click", () => {
      const section = element.dataset.sectionToggle;
      expandedSection = expandedSection === section ? null : section;
      document.querySelectorAll("[data-section-toggle]").forEach((toggle) => {
        const expanded = toggle.dataset.sectionToggle === expandedSection;
        toggle.classList.toggle("expanded", expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
      });
      document.querySelectorAll("[data-subnav-section]").forEach((subnav) => {
        const expanded = subnav.dataset.subnavSection === expandedSection;
        subnav.classList.toggle("expanded", expanded);
        subnav.setAttribute("aria-hidden", String(!expanded));
        subnav.inert = !expanded;
      });
    });
  });
  document.querySelectorAll("[data-route]").forEach((element) => {
    element.addEventListener("click", () => navigate(element.dataset.route));
  });
  document.querySelector("[data-setup-plan]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const payload = {
      enterprise: Object.fromEntries(
        ["name", "legalEntity", "accountSet", "ledger", "accountingStandard", "baseCurrency", "voucherType", "operator"]
          .map((name) => [name, String(data.get(name) || "").trim()]),
      ),
      targetSystemId: String(data.get("targetSystemId") || ""),
      targetVersion: String(data.get("targetVersion") || ""),
      deployment: String(data.get("deployment") || ""),
      sourceSystemIds: data.getAll("sourceSystemIds"),
      businessScenarios: data.getAll("businessScenarios"),
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
  document.querySelector("[data-target-template]")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file || !state.targetSystem?.id) return;
    try {
      const result = await previewTargetTemplate(file, state.targetSystem.id);
      const preview = result.preview;
      const name = window.prompt("模板档案名称：", `${state.targetSystem.brand}${state.targetSystem.product}模板`);
      if (!name) return;
      const requiredText = window.prompt("请输入必填列，使用逗号分隔：", preview.headers.join(","));
      if (requiredText == null) return;
      const validated = await validateTargetTemplate({
        name,
        targetSystemId: state.targetSystem.id,
        version: state.targetSystem.selectedVersion,
        headers: preview.headers,
        headerFingerprint: preview.headerFingerprint,
        requiredColumns: requiredText.split(",").map((item) => item.trim()).filter(Boolean),
        fieldMapping: {},
        formatRules: {},
        testImportStatus: "not_tested",
      });
      state = validated.state;
      render();
      toast(validated.ok ? "模板档案已建立，仍需测试账套导入" : validated.errors.join("；"), validated.ok ? "success" : "warning");
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelector("[data-run-setup-preflight]")?.addEventListener("click", async () => {
    try {
      const result = await runSetupPreflight();
      state = result.state;
      render();
      toast(result.ok ? "方案、系统和规则门槛已通过" : "仍有上线阻断项", result.ok ? "success" : "warning");
    } catch (error) {
      toast(error.message, "warning");
    }
  });
  document.querySelectorAll("[data-launch-evidence]").forEach((element) => {
    element.addEventListener("change", async () => {
      state.launchEvidence ||= {};
      state.launchEvidence[element.dataset.launchEvidence] = element.checked;
      state.productionActivation.enabled = false;
      await saveState(state);
      toast("测试证据已记录；请重新执行上线检查");
    });
  });
  document.querySelector("[data-activate-production]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    if (!window.confirm("确认目标公司、账套、环境和批量上限无误，并启用生产草稿保存吗？")) return;
    try {
      const result = await activateProduction(Object.fromEntries(new FormData(form)));
      state = result.state;
      render();
      toast("生产环境已启用；所有推送仍只保存凭证草稿");
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
  document.querySelector("[data-template-name]")?.addEventListener("input", (event) => {
    mappingTemplateName = event.target.value;
  });
  document.querySelector("[data-run-import]")?.addEventListener("click", runImport);
  document.querySelector("[data-download-template]")?.addEventListener("click", () => {
    downloadBlob("业务数据空白模板.csv", "\uFEFF公司,账簿,业务类型,业务日期,供应商,含税金额,审批单号,部门,项目,摘要\n", "text/csv;charset=utf-8");
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
      if (!posting.debitAccountCode || !posting.creditAccountCode) {
        return toast("规则借贷科目不完整，不能启用", "warning");
      }
      const accounts = new Set((state.masterData || [])
        .filter((item) => item.category === "account" && item.active !== false)
        .map((item) => item.code));
      if (!accounts.has(posting.debitAccountCode) || !accounts.has(posting.creditAccountCode)) {
        return toast("规则科目尚未在目标基础资料中验证，不能启用", "warning");
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
    editingRuleId = null;
    ruleEditorOpen = !ruleEditorOpen;
    render();
  });
  document.querySelectorAll("[data-edit-rule]").forEach((element) => element.addEventListener("click", () => {
    editingRuleId = element.dataset.editRule;
    ruleEditorOpen = true;
    render();
  }));
  document.querySelector("[data-cancel-rule]")?.addEventListener("click", () => {
    ruleEditorOpen = false;
    editingRuleId = null;
    render();
  });
  document.querySelector("[data-save-rule]")?.addEventListener("click", () => {
    const name = document.querySelector("[data-rule-name]")?.value.trim();
    const businessType = document.querySelector("[data-rule-business-type]")?.value.trim();
    const counterparty = document.querySelector("[data-rule-counterparty]")?.value.trim();
    const debitAccountCode = document.querySelector("[data-rule-debit-code]")?.value.trim();
    const debitAccountName = document.querySelector("[data-rule-debit-name]")?.value.trim();
    const creditAccountCode = document.querySelector("[data-rule-credit-code]")?.value.trim();
    const creditAccountName = document.querySelector("[data-rule-credit-name]")?.value.trim();
    const priority = Number(document.querySelector("[data-rule-priority]")?.value);
    if (!name || !businessType || !debitAccountCode || !debitAccountName
      || !creditAccountCode || !creditAccountName || !Number.isInteger(priority) || priority < 1) {
      return toast("请完整填写规则名称、优先级、条件和动作", "warning");
    }
    const condition = `业务类型 = ${businessType}${counterparty ? `；供应商/客商 = ${counterparty}` : ""}`;
    const action = `借：${debitAccountCode} ${debitAccountName}；贷：${creditAccountCode} ${creditAccountName}`;
    const changes = {
      name,
      priority,
      condition,
      action,
      match: { businessType, counterparty },
      posting: {
        debitAccountCode,
        debitAccountName,
        creditAccountCode,
        creditAccountName,
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
  document.querySelectorAll("[data-save-connector]").forEach((element) =>
    element.addEventListener("click", () => saveConnectorConfiguration(element.dataset.saveConnector)));
  document.querySelectorAll("[data-test-real]").forEach((element) =>
    element.addEventListener("click", () => runConnectorOperation(element.dataset.testReal, "test")));
  document.querySelectorAll("[data-sync-approvals]").forEach((element) =>
    element.addEventListener("click", () => runConnectorOperation(element.dataset.syncApprovals, "approvals")));
  document.querySelectorAll("[data-sync-master]").forEach((element) =>
    element.addEventListener("click", () => runConnectorOperation(element.dataset.syncMaster, "master")));
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
        toast(result.restartRequired ? "修复完成，重启后生效" : "环境修复已完成");
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
      route = "plan";
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
expandedSection = sectionNavigation[currentSection()] ? currentSection() : null;
if (!window.location.hash) window.history.replaceState({}, "", routeHash(route));
render();
if (route === "diagnostics") refreshDiagnostics();

window.addEventListener("popstate", () => {
  route = routeFromHash();
  expandedSection = sectionNavigation[currentSection()] ? currentSection() : null;
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
