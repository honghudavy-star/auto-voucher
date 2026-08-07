import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const workflowIconSource = readFileSync(new URL("../src/workflow-icons.js", import.meta.url), "utf8");
const viteConfig = readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("environment UI treats OCR and PDF as bundled capabilities", () => {
  assert.equal(source.includes('data-repair-environment="reinstall-ocr"'), false);
  assert.equal(source.includes('data-repair-environment="reinstall-pdf"'), false);
  assert.equal(source.includes('data-repair-environment="recreate-shortcut"'), false);
});

test("environment and update details live behind the page status control", () => {
  const systemsStart = source.indexOf("function systemsPage()");
  const systemsEnd = source.indexOf("function readonlyWorkspaceEmpty(", systemsStart);
  const systemsPage = source.slice(systemsStart, systemsEnd);

  assert.match(systemsPage, /runtimeStatusControl\(\)/);
  assert.doesNotMatch(systemsPage, /environmentCard\(/);
  assert.doesNotMatch(systemsPage, /updateCard\(/);
  assert.doesNotMatch(systemsPage, /gateStatus\("systems"\)\.tone/);
  assert.match(source, /function runtimeStatusDialog\(\)/);
  assert.match(source, /data-open-runtime-status/);
  assert.match(source, /data-runtime-status-layer/);
  assert.match(source, /class="runtime-configuration-summary/);
  assert.match(source, /系统状态/);
  assert.match(source, /配置未完成/);
  assert.match(source, /配置进度、运行环境和程序版本集中显示在这里/);
  assert.doesNotMatch(source, /阻断项未解决时不能启用生产/);
  assert.doesNotMatch(source, /Cloudflare R2|CDN 版本清单/);
  assert.match(source, /launcher_unavailable: "Docker 更新"/);
});

test("focused import, canvas, approval source, and approval processing pages hide the global search bar", () => {
  assert.match(
    source,
    /\$\{\["import", "dashboard", "approvals", "approvalProcessing"\]\.includes\(route\) \? "" : `<div class="global-search-anchor">\$\{globalSearchBox\(\)\}<\/div>`\}/,
  );
  assert.match(source, /function globalSearchBox\(className = ""\)/);
  assert.match(source, /route === "dashboard" \? "dashboard-content"/);
});

test("connector setup exposes the required Kingdee AppID and AppSecret fields", () => {
  const start = source.indexOf("function connectorsPage()");
  const end = source.indexOf("function ocrPage()", start);
  const page = source.slice(start, end);

  assert.match(page, /密钥只保存到系统密钥库/);
  assert.match(page, /其他技术设置已由系统处理，无需填写/);
  assert.match(page, /name="serverUrl"/);
  assert.match(page, /name="acctId"/);
  assert.match(page, /name="appId"/);
  assert.match(page, /第三方应用密钥（AppSecret）/);
  assert.match(page, /name="orgNum"/);
  assert.match(page, /name="ledger"/);
  assert.equal(page.includes('name="authHeader"'), false);
  assert.equal(page.includes('name="authScheme"'), false);
  assert.equal(page.includes('name="environment"'), false);
  assert.equal(page.includes('name="recordsPath"'), false);
  assert.equal(page.includes('name="endpointProfile"'), false);
  assert.equal(page.includes('name="dimensionFieldMap"'), false);
});

test("Feishu base credentials stay on connectors while approval querying has its own page", () => {
  const connectorStart = source.indexOf("function connectorsPage()");
  const connectorEnd = source.indexOf("function ocrPage()", connectorStart);
  const connectorPage = source.slice(connectorStart, connectorEnd);
  const approvalStart = source.indexOf("function approvalDataPage()");
  const approvalEnd = source.indexOf("function connectorsPage()", approvalStart);
  const approvalPage = source.slice(approvalStart, approvalEnd);

  assert.match(connectorPage, /中国大陆飞书/);
  assert.match(connectorPage, /海外 Lark/);
  assert.match(connectorPage, /App ID/);
  assert.match(connectorPage, /App Secret/);
  assert.match(connectorPage, /基础连接只验证 App ID、App Secret 和平台域名/);
  assert.match(connectorPage, /data-route="approvals"/);
  assert.doesNotMatch(connectorPage, /name="approvalCode"/);
  assert.doesNotMatch(connectorPage, /读取审批字段/);

  assert.match(source, /approvals: \{ label: "审批数据"/);
  assert.match(source, /route: "approvals"/);
  assert.match(approvalPage, /name="approvalCode"/);
  assert.match(approvalPage, /name="queryDateFrom"/);
  assert.match(approvalPage, /name="queryDateTo"/);
  assert.match(approvalPage, /审批记录完成日期/);
  assert.doesNotMatch(approvalPage, /审批记录发起日期/);
  assert.match(approvalPage, /filterApprovalRecordsByCompletionDate/);
  assert.match(approvalPage, /读取审批字段/);
  assert.match(approvalPage, /data-save-approval-config/);
  assert.match(approvalPage, /data-feishu-mapping="\$\{key\}"/);
  assert.match(approvalPage, /data-approval-filter-form/);
  assert.match(approvalPage, /aria-label="已提取审批数据"/);
  assert.match(source, /\["counterparty", "供应商 \/ 客商"/);
  assert.match(source, /\["amount", "金额"/);
  assert.doesNotMatch(source, /\["reference", "审批单号",/);
  assert.doesNotMatch(approvalPage, /approval-system-field|飞书实例编码（instance_code）/);
});

test("approval data uses three consistent top-level subcard pages", () => {
  const approvalStart = source.indexOf("function approvalDataPage()");
  const approvalEnd = source.indexOf("function connectorsPage()", approvalStart);
  const approvalPage = source.slice(approvalStart, approvalEnd);
  const approvalRender = source.slice(
    approvalStart,
    source.indexOf("function approvalProcessingAccountOptions", approvalStart),
  );

  assert.match(approvalPage, /class="approval-data-topbar" data-approval-layer="header"/);
  assert.match(approvalPage, /class="approval-data-heading-row"/);
  assert.match(approvalPage, /class="workflow-return-button approval-return-button" data-route="dashboard"/);
  assert.match(approvalPage, /<h1>审批数据<\/h1>/);
  assert.match(approvalPage, /class="primary-button approval-sync-button"/);
  assert.match(approvalPage, /class="approval-subcards" role="tablist" aria-label="审批数据页面"/);
  assert.match(approvalPage, /\["query", "查询范围"\]/);
  assert.match(approvalPage, /\["mapping", "字段映射"\]/);
  assert.match(approvalPage, /\["records", "审批记录"\]/);
  assert.match(approvalPage, /data-approval-panel="\$\{panelId\}"/);
  assert.match(approvalPage, /class="approval-page-panel glass-panel approval-query-section"/);
  assert.match(approvalPage, /class="approval-page-panel glass-panel approval-mapping-section"/);
  assert.match(approvalPage, /class="approval-records-workspace"/);
  assert.match(approvalPage, /class="approval-records-controls" data-approval-layer="controls"/);
  assert.match(approvalPage, /class="approval-table-layer" data-approval-layer="table"/);
  assert.equal((approvalRender.match(/data-approval-layer="/g) || []).length, 3);
  assert.doesNotMatch(approvalRender, /approval-selection-toolbar|approval-results-panel/);
  assert.match(approvalPage, /data-approval-page="query"/);
  assert.match(approvalPage, /data-approval-page="mapping"/);
  assert.match(approvalPage, /data-approval-page="records"/);
  assert.match(approvalPage, /class="approval-source-bar"/);
  assert.match(approvalPage, /data-open-approval-additional-field/);
  assert.match(approvalPage, /data-add-approval-additional-field/);
  assert.match(approvalPage, /data-remove-approval-additional-field/);
  assert.match(approvalPage, /添加其他字段/);
  assert.match(approvalPage, /当前审批模板中尚未映射的字段/);
  assert.match(source, /<optgroup label="飞书审批字段">/);
  assert.doesNotMatch(approvalPage, /添加其他来源字段|按审批单号与该来源的单据号关联/);
  assert.doesNotMatch(source, /<optgroup label="其他数据来源">/);
  assert.match(source, /additionalApprovalFieldIds/);
  assert.match(source, /fieldSources:\s*\[\]/);
  assert.doesNotMatch(approvalPage, /class="eyebrow">(?:查询定义|提取结果)/);
  assert.doesNotMatch(approvalPage, /选择审批模板、映射标准字段|仅筛选本地已同步数据|data-route="connectors"/);
  assert.match(source, /route === "approvals" \? "" : `<span>\$\{escapeHtml\(routes\[route\]\?\.label \|\| ""\)\}<\/span>`/);
  assert.match(source, /\["dashboard", "approvals"\]\.includes\(route\) \? "" : workflowReturnBar\(\)/);
  assert.match(source, /document\.querySelectorAll\("\[data-approval-panel\]"\)/);
  assert.match(styles, /\.approval-subcards\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
  assert.match(styles, /\.approval-subcards\s*\{[^}]*gap:\s*10px;[^}]*background:\s*transparent/s);
  assert.match(styles, /\.approval-subcard\s*\{[^}]*border:\s*1px solid var\(--border\);[^}]*background:\s*var\(--surface-strong\)/s);
  assert.match(styles, /\.approval-subcard\.active\s*\{[^}]*color:\s*var\(--surface-strong\);[^}]*background:\s*var\(--ink\)/s);
  assert.match(styles, /\.approval-page-panel\[hidden\],\s*\.approval-records-workspace\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.approval-page-header\s*\{[^}]*min-height:\s*58px/s);
  assert.match(styles, /\.approval-mapping-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.approval-mapping-grid label\s*\{[^}]*min-height:\s*72px/s);
  assert.match(styles, /\.approval-additional-field-editor\s*\{/);
  assert.doesNotMatch(styles, /\.approval-config-panel/);
  assert.doesNotMatch(styles, /\.approval-date-candidates/);
});

test("all connector secrets use password masking and stored-value asterisks", () => {
  const start = source.indexOf("function connectorsPage()");
  const end = source.indexOf("function ocrPage()", start);
  const page = source.slice(start, end);
  const secretInputs = page.match(/name="secret" type="password" data-secret-input/g) || [];

  assert.equal(secretInputs.length, 4);
  assert.match(source, /const CONFIG_VALUE_MASK = "\*{8}"/);
  assert.match(page, /const maskedSecretPlaceholder = connector\.status === "not_configured"\s*\? ""\s*:\s*CONFIG_VALUE_MASK/);
  assert.doesNotMatch(page, /name="secret"[^>]*value=/);
});

test("saved connection credentials render masked while approval query fields remain visible", () => {
  const start = source.indexOf("function connectorsPage()");
  const end = source.indexOf("function ocrPage()", start);
  const page = source.slice(start, end);
  const approvalStart = source.indexOf("function approvalDataPage()");
  const approvalEnd = source.indexOf("function connectorsPage()", approvalStart);
  const approvalPage = source.slice(approvalStart, approvalEnd);
  const requiredMaskedFields = [
    "connector.serverUrl",
    "connector.acctId",
    "connector.username",
    "connector.appId",
    "connector.orgNum",
    "connector.ledger",
    "connector.baseUrl",
  ];

  requiredMaskedFields.forEach((field) => {
    assert.match(page, new RegExp(`maskedConfigValue\\(${field.replace(".", "\\.")}\\)`));
  });
  assert.match(source, /function submittedConfigValue\(value, existingValue\)/);
  assert.match(source, /submitted === CONFIG_VALUE_MASK/);
  assert.match(page, /item\.name === "目标范围" \? CONFIG_VALUE_MASK : item\.detail/);
  assert.doesNotMatch(
    page,
    /value="\$\{escapeHtml\(connector\.(serverUrl|acctId|username|appId|orgNum|ledger|baseUrl)/,
  );
  assert.doesNotMatch(page, /name="approvalCode"/);
  assert.match(approvalPage, /name="approvalCode" value="\$\{escapeHtml\(approvalProfile\.approvalCode \|\| ""\)\}"/);
  assert.match(approvalPage, /escapeHtml\(approvalProfile\.approvalName \|\| "已读取审批模板"\)/);
  assert.match(approvalPage, /新增 approval_code/);
  assert.match(approvalPage, /data-select-approval-profile/);
  assert.match(approvalPage, /escapeHtml\(field\.name\).*escapeHtml\(field\.id\)/s);
  assert.match(source, /configureConnectorApprovalQuery/);
});

test("connector workspace uses the full content area beside the shared sidebar", () => {
  assert.match(styles, /grid-template-columns:\s*236px minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.content\.connector-content\s*\{[^}]*height:\s*100vh;[^}]*display:\s*flex;[^}]*padding:\s*0;/s);
  assert.match(styles, /\.connector-workspace\s*\{[^}]*height:\s*auto;[^}]*flex:\s*1;/s);
  assert.match(source, /route === "dashboard" \? "dashboard-content" : route === "connectors" \? "connector-content" : route === "approvals" \? "approval-content"/);
});

test("systems page selects one module at a time instead of stacking cards", () => {
  const systemsStart = source.indexOf("function systemsPage()");
  const systemsEnd = source.indexOf("function readonlyWorkspaceEmpty(", systemsStart);
  const systemsPage = source.slice(systemsStart, systemsEnd);

  assert.match(systemsPage, /role="tablist" aria-label="系统与数据模块"/);
  assert.match(systemsPage, /data-systems-panel=/);
  assert.match(systemsPage, /systems-panel-content/);
  assert.doesNotMatch(systemsPage, /settings-grid setup-system-grid/);
  assert.doesNotMatch(systemsPage, /ERP 模板档案|模板路径|data-target-template/);
});

test("sidebar follows the exact core, business data, and settings information architecture", () => {
  const sidebarStart = source.indexOf("const sidebarNavigation =");
  const sidebarEnd = source.indexOf("const iconPaths =", sidebarStart);
  const sidebarConfig = source.slice(sidebarStart, sidebarEnd);

  assert.match(source, /let route = "dashboard"/);
  assert.match(source, /const path = window\.location\.hash\.replace\(\/\^#\/, ""\) \|\| routes\.dashboard\.path/);
  assert.match(sidebarConfig, /label: "核心流程"[\s\S]*route: "dashboard"[\s\S]*route: "plan"[\s\S]*route: "systems"[\s\S]*route: "rules"/);
  assert.match(sidebarConfig, /label: "业务数据"[\s\S]*route: "bank"[\s\S]*route: "business"[\s\S]*route: "approvals"[\s\S]*route: "depreciation"/);
  assert.match(sidebarConfig, /label: "设置"[\s\S]*route: "connectors"[\s\S]*route: "ocr"[\s\S]*route: "settings"[\s\S]*route: "diagnostics"[\s\S]*route: "backup"/);
  assert.doesNotMatch(sidebarConfig, /route: "(?:import|events|exceptions|vouchers|delivery|templates)"/);
  assert.doesNotMatch(source, /sidebarBadges|nav-count/);
  assert.match(source, /route === item\.route \? "active" : ""/);
  assert.match(source, /aria-current="\$\{route === item\.route \? "page" : "false"\}"/);
  assert.doesNotMatch(styles, /\.sidebar \.primary-nav-item(?:\.active)?::before/);
  assert.doesNotMatch(source, /const workflowSidebar = route === "dashboard"/);
  assert.doesNotMatch(source, /\["settings", "diagnostics", "backup"\]\.includes\(route\)/);
  Object.keys({
    dashboard: true,
    bank: true,
    business: true,
    depreciation: true,
    import: true,
    events: true,
    exceptions: true,
    vouchers: true,
    delivery: true,
    plan: true,
    systems: true,
    rules: true,
    templates: true,
    connectors: true,
    approvals: true,
    approvalProcessing: true,
    ocr: true,
    settings: true,
    diagnostics: true,
    backup: true,
  }).forEach((routeName) => {
    assert.match(source, new RegExp(`route: "${routeName}"`));
  });
});

test("business data sidebar routes resolve to scoped data views", () => {
  assert.match(source, /bank: \{ label: "银行数据"[^}]*path: "\/workspace\/bank-data"/);
  assert.match(source, /business: \{ label: "业务数据"[^}]*path: "\/workspace\/business-data"/);
  assert.match(source, /depreciation: \{ label: "折旧摊销"[^}]*path: "\/workspace\/depreciation-data"/);
  assert.match(source, /bank: \(\) => eventsPage\("bank"\)/);
  assert.match(source, /business: \(\) => eventsPage\("business"\)/);
  assert.match(source, /depreciation: \(\) => eventsPage\("depreciation"\)/);
  assert.match(source, /const isBank = isBankRecord\(event\)/);
  assert.match(source, /const isDepreciation = \/\(折旧\|摊销\|固定资产\|待摊\)\//);
  assert.match(source, /event\.sourceSystem !== "feishu" && !isBank && !isDepreciation/);
});

test("structured import cannot continue after preview failure", () => {
  assert.match(source, /let importPreviewError = ""/);
  assert.match(source, /importPreviewError = error\.message/);
  assert.match(source, /if \(importPreviewError \|\| \(singleStructuredImport && !importPreview\)\)/);
  assert.match(source, /data-run-import \$\{importProgress \|\| importPreviewLoading \|\| importPreviewError \? "disabled" : ""\}/);
});

test("import preview distinguishes source fields from generated processing fields", () => {
  assert.match(source, /源文件 \$\{importPreview\.sourceHeaders\.length\} 个字段/);
  assert.match(source, /系统生成 \$\{importPreview\.derivedHeaders\.length\} 个处理字段/);
  assert.match(source, /<optgroup label="源文件字段">/);
  assert.match(source, /<optgroup label="系统处理字段">/);
  assert.match(source, /importPreview\.sourceHeaders\.slice\(0, 4\)/);
  assert.match(source, /系统处理字段由银行借方、贷方等原始列自动生成，不会修改 Excel 文件/);
});

test("payment amount mapping supports selecting debit and credit together", () => {
  assert.match(source, /\["amount", "付款金额", true, "multiple"\]/);
  assert.match(source, /data-mapping-multi-field="amount"/);
  assert.match(source, /normalizeMappingSelection\(fieldMapping\.amount\)/);
  assert.match(source, /请选择“供应商 \/ 客商”和至少一个“付款金额”字段/);
  assert.match(source, /公司,账簿,业务类型,业务日期,供应商,付款金额,审批单号/);
});

test("selected import files use a compact source rail and dominant mapping workspace", () => {
  assert.match(source, /class="import-grid \$\{pendingFiles\.length \? "has-selection" : ""\}"/);
  assert.match(source, /class="selected-source-panel"/);
  assert.match(source, /class="source-file-facts"/);
  assert.match(source, /class="import-workspace-scroll"/);
  assert.match(source, /class="import-action-bar"/);
  assert.match(styles, /\.import-grid\.has-selection\s*\{[^}]*grid-template-columns:\s*minmax\(270px,\s*300px\)\s+minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.import-preview\.is-ready \.mapping-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
  assert.match(styles, /\.import-preview\.is-ready\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
  assert.match(styles, /\.import-action-bar\s*\{/);
});

test("workflow canvas keeps source and output disclosure while exposing every node", () => {
  const dashboardStart = source.indexOf("function dashboardPage()");
  const dashboardEnd = source.indexOf("function importPage()", dashboardStart);
  const dashboard = source.slice(dashboardStart, dashboardEnd);
  const sourceNodesStart = dashboard.indexOf("const sourceNodes = [");
  const sourceNodesEnd = dashboard.indexOf("const sourceDetails", sourceNodesStart);
  const sourceNodes = dashboard.slice(sourceNodesStart, sourceNodesEnd);

  assert.match(dashboard, /class="workflow-canvas-shell"/);
  assert.match(dashboard, /class="workflow-canvas-surface"/);
  assert.match(dashboard, /class="workflow-stage-headings"/);
  assert.match(dashboard, /class="workflow-stage-heading"><strong>数据来源<\/strong>/);
  assert.match(dashboard, /class="workflow-stage-heading"><strong>数据处理<\/strong>/);
  assert.match(dashboard, /class="workflow-stage-heading"><strong>数据输出<\/strong>/);
  assert.doesNotMatch(dashboard, /workflow-canvas-stage-number|workflow-canvas-stage-copy|workflow-canvas-stage-rail-meta/);
  assert.doesNotMatch(dashboard, /4 类数据|8 个处理节点|2 个输出目标/);
  assert.doesNotMatch(sourceNodes, /\bmeta:/);
  assert.equal((dashboard.match(/class="workflow-stage-heading"/g) || []).length, 3);
  assert.ok(
    dashboard.indexOf('class="workflow-canvas-viewport"') < dashboard.indexOf('class="workflow-stage-headings"'),
    "stage titles should live inside the canvas viewport",
  );
  assert.match(styles, /\.workflow-stage-headings\s*\{[^}]*grid-template-columns:\s*28%\s+50%\s+22%/s);
  assert.doesNotMatch(dashboard, /workflow-canvas-stage-card/);
  assert.match(dashboard, /id: "source-bank"/);
  assert.match(dashboard, /id: "source-business"/);
  assert.match(dashboard, /id: "source-approval"/);
  assert.match(dashboard, /id: "source-depreciation"/);
  assert.match(dashboard, /id: "output-erp"/);
  assert.match(dashboard, /id: "output-template"/);
  assert.match(dashboard, /本地导入/);
  assert.match(dashboard, /API 接入/);
  assert.match(dashboard, /Excel 凭证模板/);
  assert.match(source, /data-workflow-node/);
  assert.match(dashboard, /class="workflow-inspector-panel workflow-inspector-popover"/);
  assert.match(dashboard, /data-close-workflow-inspector/);
  assert.doesNotMatch(dashboard, /page-heading|workflow-heading-actions|财务流程设计器/);
  assert.match(dashboard, /workflow-topbar[\s\S]*<h1>自动生成凭证流程<\/h1>/);
  assert.match(styles, /\.content\.dashboard-content\s*\{[^}]*height:\s*100vh/s);
});

test("workflow canvas node cards use semantic colorful icons without changing global icons", () => {
  const dashboardStart = source.indexOf("function dashboardPage()");
  const dashboardEnd = source.indexOf("function importPage()", dashboardStart);
  const dashboard = source.slice(dashboardStart, dashboardEnd);

  assert.match(source, /import\s+\{\s*workflowNodeIcon\s*\}\s+from\s+"\.\/workflow-icons\.js"/);
  assert.match(dashboard, /class="workflow-canvas-node-icon">\$\{workflowNodeIcon\(node\.id\)\}<\/span>/);
  assert.doesNotMatch(dashboard, /class="workflow-canvas-node-icon">\$\{icon\(node\.iconName\)\}<\/span>/);
  assert.match(source, /function icon\(name, className = ""\)/);
  assert.match(viteConfig, /import Icons from "unplugin-icons\/vite"/);
  assert.match(viteConfig, /plugins:\s*\[\s*Icons\(\)/s);
  assert.ok(packageJson.devDependencies["unplugin-icons"]);
  assert.ok(packageJson.devDependencies["@iconify-json/fluent-color"]);
  assert.equal(
    (workflowIconSource.match(/~icons\/fluent-color\/[^"]+\?raw&width=24&height=24/g) || []).length,
    14,
  );
  [
    ["source-bank", "coin-multiple-24"],
    ["source-business", "briefcase-24"],
    ["source-approval", "approvals-app-24"],
    ["source-depreciation", "calendar-data-bar-24"],
    ["process-systems", "book-database-24"],
    ["process-business", "search-sparkle-24"],
    ["process-bank", "data-bar-vertical-ascending-24"],
    ["process-approval", "clipboard-task-24"],
    ["process-depreciation", "calendar-sync-24"],
    ["process-rules", "options-24"],
    ["process-exceptions", "warning-24"],
    ["process-vouchers", "document-add-24"],
    ["output-erp", "cloud-24"],
    ["output-template", "table-24"],
  ].forEach(([nodeId, iconName]) => {
    assert.match(workflowIconSource, new RegExp(`import [^\\n]+fluent-color/${iconName}\\?raw`));
    assert.match(workflowIconSource, new RegExp(`"${nodeId}": [A-Za-z]+Icon`));
  });
  assert.match(styles, /\.workflow-canvas-node-icon\s*>\s*svg\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/s);
});

test("workflow canvas supports draggable persisted nodes and live SVG connections", () => {
  const dashboardStart = source.indexOf("function dashboardPage()");
  const dashboardEnd = source.indexOf("function importPage()", dashboardStart);
  const dashboard = source.slice(dashboardStart, dashboardEnd);

  assert.match(dashboard, /class="workflow-canvas-connections"/);
  assert.match(dashboard, /class="workflow-canvas-edge workflow-canvas-edge-/);
  assert.match(dashboard, /class="workflow-canvas-edge-flow workflow-canvas-edge-flow-/);
  assert.match(dashboard, /class="workflow-canvas-edge-hit"/);
  assert.match(dashboard, /data-canvas-node=/);
  assert.match(dashboard, /data-workflow-lane=/);
  assert.doesNotMatch(dashboard, /data-reset-workflow-canvas/);
  assert.doesNotMatch(dashboard, /data-canvas-zoom-out/);
  assert.doesNotMatch(dashboard, /data-canvas-zoom-reset/);
  assert.doesNotMatch(dashboard, /data-canvas-zoom-in/);
  assert.doesNotMatch(dashboard, /data-stage-card-handle|data-stage-card-resize/);
  assert.match(source, /const WORKFLOW_CANVAS_DEFAULT_POSITIONS/);
  assert.match(source, /const WORKFLOW_CANVAS_VIEW_STORAGE_KEY/);
  assert.match(source, /const WORKFLOW_CANVAS_EDGE_STORAGE_KEY/);
  assert.match(source, /function attachWorkflowCanvas\(\)/);
  assert.match(source, /setPointerCapture/);
  assert.match(source, /updateWorkflowCanvasEdges/);
  assert.match(source, /saveWorkflowCanvasPositions/);
  assert.match(source, /applyWorkflowCanvasView/);
  assert.match(source, /pointerDeltaX\s*\/\s*workflowCanvasView\.zoom/);
  assert.match(source, /clampWorkflowCanvasNodeLeft\(\{/);
  assert.match(source, /event\.target\.closest\("\.workflow-canvas-edge-hit"\)/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /viewport\.setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /event\.target\.closest\("\[data-canvas-node\], \.workflow-canvas-edge-hit"\)/);
  assert.match(source, /saveWorkflowCanvasEdgeRoutes\(\)/);
  assert.doesNotMatch(source, /let panState|classList\.add\("panning"\)|workflowCanvasView\.x -= event\.deltaX/);
  assert.doesNotMatch(source, /focusX - \(worldX \* zoom\)|focusY - \(worldY \* zoom\)/);
  assert.doesNotMatch(dashboard, /aria-label="拖动画布"/);
  assert.match(styles, /\.workflow-canvas-node\s*\{[^}]*touch-action:\s*none/s);
  assert.match(styles, /\.workflow-canvas-edge-hit\s*\{[^}]*stroke-width:\s*16;[^}]*pointer-events:\s*stroke;[^}]*touch-action:\s*none;[^}]*cursor:\s*col-resize;/s);
  assert.match(styles, /\.workflow-canvas-connections\s*\{[^}]*pointer-events:\s*auto;/s);
  assert.match(styles, /\.workflow-canvas-edge,\s*\.workflow-canvas-edge-flow\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(styles, /\.workflow-canvas-surface\s*\{[^}]*transform-origin:\s*0 0/s);
  assert.match(styles, /\.workflow-canvas-viewport\s*\{[^}]*cursor:\s*default/s);
  assert.doesNotMatch(styles, /\.workflow-canvas-viewport\.panning/);
  assert.doesNotMatch(dashboard, /workflow-canvas-column-lines/);
  assert.match(styles, /\/\* Fixed three-lane workflow header and canvas guides \*\//);
  assert.match(styles, /\.workflow-canvas-viewport::before\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*repeating-linear-gradient[^}]*background-position:\s*28%\s+0,\s*78%\s+0;[^}]*background-size:\s*1px\s+100%,\s*1px\s+100%;/s);
  assert.match(styles, /\.workflow-canvas-surface\s*\{[^}]*z-index:\s*1;[^}]*background-color:\s*transparent;/s);
  assert.doesNotMatch(styles, /\.workflow-canvas-stage-card/);
  assert.doesNotMatch(dashboard, /class="workflow-board"/);
});

test("workflow workspace follows the reference editor shell", () => {
  const dashboardStart = source.indexOf("function dashboardPage()");
  const dashboardEnd = source.indexOf("function importPage()", dashboardStart);
  const dashboard = source.slice(dashboardStart, dashboardEnd);
  const unifiedStyles = styles.slice(styles.indexOf("/* Unified desktop editor system */"));
  const fixedLaneStyles = styles.slice(styles.indexOf("/* Fixed three-lane workflow header and canvas guides */"));

  assert.match(source, /class="sidebar glass-panel"/);
  assert.doesNotMatch(source, /class="sidebar \$\{workflowSidebar/);
  assert.doesNotMatch(source, /workflow-window-dots/);
  assert.doesNotMatch(source, /class="workflow-sidebar-sources"/);
  assert.doesNotMatch(source, /data-sidebar-workflow-node=/);
  assert.doesNotMatch(dashboard, /workflow-canvas-toolbar|workflow-editor-search|workflow-editor-actions|workflow-editor-utilities/);
  assert.match(dashboard, /class="workflow-stage-headings"/);
  assert.equal((dashboard.match(/class="workflow-stage-heading"/g) || []).length, 3);
  assert.match(dashboard, /class="workflow-canvas-minimap"/);
  assert.match(dashboard, /class="workflow-canvas-tools"/);
  assert.match(dashboard, /class="workflow-inspector-tabs"/);
  assert.match(dashboard, /const inspector = activeDetail && activeNode \?/);
  assert.match(dashboard, /class="workflow-inspector-panel workflow-inspector-popover"/);
  assert.doesNotMatch(dashboard, /workflow-inspector-empty/);
  assert.doesNotMatch(source, /class="local-card"/);
  assert.match(unifiedStyles, /body\s*\{[^}]*font-size:\s*var\(--text-base\)/s);
  assert.match(unifiedStyles, /\.app-shell\s*\{[^}]*grid-template-columns:\s*236px\s+minmax\(0,\s*1fr\)/s);
  assert.match(fixedLaneStyles, /\/\* Full-width canvas with contextual node settings \*\//);
  assert.match(fixedLaneStyles, /\.workflow-canvas-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
  assert.match(fixedLaneStyles, /\.workflow-inspector-popover\s*\{[^}]*position:\s*absolute;[^}]*right:\s*16px;[^}]*width:\s*min\(340px,\s*calc\(100%\s*-\s*32px\)\)/s);
  assert.match(fixedLaneStyles, /\.workflow-stage-headings\s*\{[^}]*position:\s*absolute;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*pointer-events:\s*none;/s);
  assert.match(fixedLaneStyles, /\.workflow-stage-heading\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;[^}]*padding:\s*0;/s);
  assert.match(fixedLaneStyles, /\.workflow-stage-heading::before\s*\{[^}]*display:\s*none;/s);
  assert.match(fixedLaneStyles, /\.workflow-stage-heading\s*>\s*strong\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(unifiedStyles, /\.workflow-canvas-node\s*\{[^}]*width:\s*190px;[^}]*border-radius:\s*8px/s);
  assert.match(source, /`M \$\{startX\.toFixed\(1\)\} \$\{startY\.toFixed\(1\)\} H \$\{middleX\.toFixed\(1\)\} V \$\{endY\.toFixed\(1\)\} H \$\{endX\.toFixed\(1\)\}`/);
});

test("workflow workspace keeps a focused command topbar above the canvas", () => {
  const dashboardStart = source.indexOf("function dashboardPage()");
  const dashboardEnd = source.indexOf("function importPage()", dashboardStart);
  const dashboard = source.slice(dashboardStart, dashboardEnd);

  assert.match(dashboard, /class="workflow-topbar"/);
  assert.match(dashboard, /自动生成凭证流程/);
  assert.match(dashboard, /class="workflow-save-state"/);
  assert.doesNotMatch(dashboard, /workflow-topbar-summary|workflow-topbar-metrics|workflow-validation-status/);
  assert.doesNotMatch(dashboard, /workflowNodeCount|workflowConnectionCount|workflowBlockingCount|workflowWarningCount/);
  assert.match(dashboard, /data-validate-workflow/);
  assert.match(dashboard, /data-route="vouchers"/);
  assert.match(dashboard, /data-open-runtime-status/);
  assert.ok(dashboard.indexOf('class="workflow-topbar"') < dashboard.indexOf('class="workflow-canvas-shell"'));
  assert.match(source, /document\.querySelector\("\[data-validate-workflow\]"\)/);
  assert.match(styles, /\.workflow-topbar\s*\{[^}]*min-height:\s*76px;[^}]*display:\s*grid;/s);
  assert.match(styles, /\.workflow-topbar-primary\s*\{[^}]*background:\s*var\(--coral\)/s);
  assert.doesNotMatch(dashboard, /发布运行|自动过账/);
  assert.match(source, /class="sidebar glass-panel"/);
});

test("all useful pages are reachable from the workflow and every subpage can return", () => {
  const dashboardStart = source.indexOf("function dashboardPage()");
  const dashboardEnd = source.indexOf("function importPage()", dashboardStart);
  const dashboard = source.slice(dashboardStart, dashboardEnd);
  const expectedRoutes = [
    "plan",
    "systems",
    "import",
    "events",
    "exceptions",
    "vouchers",
    "rules",
    "connectors",
    "approvals",
    "approvalProcessing",
    "ocr",
    "delivery",
    "templates",
  ];

  expectedRoutes.forEach((routeName) => {
    assert.match(dashboard, new RegExp(`route: "${routeName}"|data-route="${routeName}"`));
  });
  assert.match(source, /\$\{\["dashboard", "approvals"\]\.includes\(route\) \? "" : workflowReturnBar\(\)\}/);
  assert.match(source, /data-route="dashboard">[^<]*\$\{icon\("arrow"\)\}返回流程工作区/);
  assert.match(source, /class="workflow-return-button approval-return-button" data-route="dashboard"/);
  assert.match(source, /data-route="diagnostics"/);
  assert.match(source, /data-route="backup"/);
});

test("approval processing shows a full bank-approval union with local account and scenario actions", () => {
  const processingStart = source.indexOf("function approvalProcessingPage()");
  const processingEnd = source.indexOf("function connectorsPage()", processingStart);
  const processingPage = source.slice(processingStart, processingEnd);

  assert.match(source, /approvalProcessing: \{ label: "审批数据处理"[^}]*path: "\/workspace\/approval-processing"/);
  assert.match(source, /id: "process-approval"[^}]*route: "approvalProcessing"/);
  assert.match(source, /approvalProcessing: approvalProcessingPage/);
  assert.match(processingPage, /银行流水 ∪ 已确认审批记录/);
  assert.match(processingPage, /aria-label="银行与审批联合处理表"/);
  assert.match(processingPage, /<colgroup>/);
  assert.match(processingPage, /approval-union-col-approval-date/);
  assert.match(processingPage, /approval-union-col-approval-template/);
  assert.match(processingPage, /approval-union-col-approval-content/);
  assert.match(processingPage, /approval-union-col-approval-amount/);
  assert.match(processingPage, /data-union-account-event/);
  assert.match(processingPage, /data-union-rule-row/);
  assert.match(processingPage, /data-generate-union-row/);
  assert.match(processingPage, /data-auto-generate-union/);
  assert.match(processingPage, /data-open-approval-detail="\$\{escapeHtml\(approval\.id\)\}"/);
  assert.match(processingPage, /approvalRecordDetailModal\(detailRecord, detailConnector\)/);
  assert.match(processingPage, /未确认审批不会传入/);
  assert.match(processingPage, /approval-processing-gate/);
  assert.match(source, /approvalRecordsForProcessing\(/);
  assert.match(source, /assignApprovalAccount\(/);
  assert.match(source, /buildVoucherForUnionRow\(/);
  assert.match(source, /"补充审批科目"/);
  assert.match(styles, /\.approval-union-summary\s*\{/);
  assert.match(styles, /\.approval-union-table\s*\{/);
  assert.match(styles, /\.approval-union-col-approval-template\s*\{/);
  assert.doesNotMatch(styles, /\.approval-union-table th:nth-child\(3\)/);
});

test("approval records require multi-select confirmation before processing", () => {
  const approvalStart = source.indexOf("function approvalDataPage()");
  const approvalEnd = source.indexOf("function approvalProcessingAccountOptions", approvalStart);
  const approvalPage = source.slice(approvalStart, approvalEnd);

  assert.match(approvalPage, /data-select-visible-approvals/);
  assert.match(approvalPage, /data-select-approval-record/);
  assert.match(approvalPage, /data-confirm-approval-selection/);
  assert.match(approvalPage, /data-revoke-approval-selection/);
  assert.match(approvalPage, /确认后才会进入审批数据处理/);
  assert.match(approvalPage, /data-clear-approval-selection/);
  assert.match(approvalPage, /\$\{selectedApprovalRecordIds\.size \? `/);
  assert.match(approvalPage, /\$\{confirmedRecordCount \? `[\s\S]*data-route="approvalProcessing"/);
  assert.match(source, /updateSelectedApprovalTransfer\(true\)/);
  assert.match(source, /updateSelectedApprovalTransfer\(false\)/);
  assert.match(source, /selectedApprovalRecordIds\.clear\(\);\s*render\(\);/);
  assert.match(styles, /\.approval-records-commandbar\s*\{/);
  assert.doesNotMatch(styles, /\.approval-selection-toolbar\s*\{/);
});

test("approval record filters expose custom conditions without the redundant shortcut block", () => {
  const approvalStart = source.indexOf("function approvalDataPage()");
  const approvalEnd = source.indexOf("function approvalProcessingAccountOptions", approvalStart);
  const approvalPage = source.slice(approvalStart, approvalEnd);

  assert.match(source, /let approvalFiltersExpanded = false/);
  assert.match(approvalPage, /data-toggle-approval-filters/);
  assert.match(approvalPage, /aria-controls="approval-custom-filters"/);
  assert.match(approvalPage, /id="approval-custom-filters"/);
  assert.match(approvalPage, /approvalFiltersExpanded \? "" : "hidden"/);
  assert.match(approvalPage, /class="approval-toolbar-search"/);
  assert.doesNotMatch(approvalPage, /class="approval-filter-panel"/);
  assert.doesNotMatch(approvalPage, /class="approval-filter-fields"/);
  assert.doesNotMatch(approvalPage, /<input type="date" name="dateFrom"/);
  assert.doesNotMatch(approvalPage, /<input type="date" name="dateTo"/);
  assert.doesNotMatch(approvalPage, /data-clear-approval-filters/);
  assert.doesNotMatch(approvalPage, /approvalDataFilters\.(?:status|dateFrom|dateTo)/);
  assert.match(source, /approvalFiltersExpanded = !approvalFiltersExpanded/);
  assert.match(styles, /\.approval-custom-filters\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.approval-toolbar-search\s*\{/);
  assert.doesNotMatch(styles, /\.approval-filter-(?:panel|fields|actions)(?:-heading)?\s*\{/);
  assert.doesNotMatch(approvalPage, /class="approval-filterbar"/);
});

test("approval records support custom multi-field AND filters", () => {
  const approvalStart = source.indexOf("function approvalDataPage()");
  const approvalEnd = source.indexOf("function approvalProcessingAccountOptions", approvalStart);
  const approvalPage = source.slice(approvalStart, approvalEnd);

  assert.match(source, /APPROVAL_PROCESSING_FIELDS/);
  assert.match(source, /approvalProcessingFieldsForConnector/);
  assert.match(source, /approvalRecordMatchesCondition/);
  assert.match(source, /approvalRecordSearchValues/);
  assert.match(approvalPage, /data-approval-custom-filter-form/);
  assert.match(approvalPage, /data-add-approval-custom-filter/);
  assert.match(approvalPage, /data-clear-approval-custom-filters/);
  assert.match(source, /data-approval-custom-field/);
  assert.match(source, /data-approval-custom-operator/);
  assert.match(source, /data-approval-custom-value/);
  assert.match(source, /<optgroup label="审批模板全部字段">/);
  assert.match(approvalPage, /搜索审批单号、标准字段或全部审批字段/);
  assert.match(approvalPage, /多个条件按“并且（AND）”组合/);
  assert.match(source, /approvalDataCustomFilters\.every\(\(condition\) =>/);
  assert.match(source, /approvalRecordMatchesCondition\(\{[\s\S]*?\}, condition, approvalFilterFields\)/);
  assert.match(source, /approvalName: event\.approvalName \|\| connector\.approvalName \|\| ""/);
  assert.match(source, /请完整填写每个自定义筛选条件/);
  assert.match(styles, /\.approval-custom-filters\s*\{/);
  assert.match(styles, /\.approval-custom-filter-row\s*\{/);
});

test("approval record number opens read-only full detail while counterparty edits stay row-scoped", () => {
  const approvalStart = source.indexOf("function approvalDataPage()");
  const approvalEnd = source.indexOf("function approvalProcessingAccountOptions", approvalStart);
  const approvalPage = source.slice(approvalStart, approvalEnd);
  const detailStart = source.indexOf("function approvalRecordDetailModal");
  const detailEnd = source.indexOf("function approvalDataPage()", detailStart);
  const detailModal = source.slice(detailStart, detailEnd);

  assert.match(approvalPage, /data-open-approval-detail=/);
  assert.match(approvalPage, /data-edit-approval-counterparty=/);
  assert.match(source, /data-approval-counterparty-form=/);
  assert.match(source, /仅修改当前审批记录/);
  assert.match(detailModal, /role="dialog"/);
  assert.match(detailModal, /完整审批数据/);
  assert.match(detailModal, /approvalRecordFieldEntries/);
  assert.doesNotMatch(detailModal, /data-approval-counterparty-form/);
  assert.match(source, /assignApprovalCounterpartyFromField/);
  assert.match(source, /修改审批供应商 \/ 客商/);
  assert.match(styles, /\.approval-detail-layer\s*\{/);
  assert.match(styles, /\.approval-counterparty-editor-row\s*>\s*td\s*\{/);
});

test("obsolete query route is removed while settings remains", () => {
  assert.match(source, /rules: \{ label: "凭证场景"/);
  assert.doesNotMatch(source, /function launchPage\(\)/);
  assert.equal(source.includes('path: "/setup/launch"'), false);
  assert.doesNotMatch(source, /query: \{ label:/);
  assert.match(source, /settings: \{ label: "通用设置"/);
});

test("voucher scenarios use a row-based entry editor with readable templates and three value sources", () => {
  const rulesStart = source.indexOf("function rulesPage()");
  const rulesEnd = source.indexOf("function approvalFieldOptions", rulesStart);
  const rulesPage = source.slice(rulesStart, rulesEnd);

  assert.match(rulesPage, /aria-label="凭证分录模板"/);
  assert.match(rulesPage, /<th>摘要<\/th>/);
  assert.match(rulesPage, /<th>科目编码<span class="required-mark">\*<\/span><\/th>/);
  assert.match(rulesPage, /<th>科目全名<\/th>/);
  assert.match(rulesPage, /<th>核算维度<\/th>/);
  assert.match(rulesPage, /<th>币别<span class="required-mark">\*<\/span><\/th>/);
  assert.match(rulesPage, /<th>汇率类型<span class="required-mark">\*<\/span><\/th>/);
  assert.match(rulesPage, /<th>原币金额<\/th>/);
  assert.match(rulesPage, /<th>单位<\/th>/);
  assert.match(rulesPage, /<th>单价<\/th>/);
  assert.match(rulesPage, /<th>数量<\/th>/);
  assert.match(rulesPage, /<th>借方金额<\/th>/);
  assert.match(rulesPage, /<th>贷方金额<\/th>/);
  assert.match(rulesPage, /<th>结算方式<\/th>/);
  assert.match(rulesPage, /<th>结算号<\/th>/);
  assert.match(rulesPage, /class="rule-grid-actions"/);
  assert.match(rulesPage, /class="rule-table-cell-button/);
  assert.match(rulesPage, /data-rule-line-field="summary"/);
  assert.match(rulesPage, /data-rule-line-field="exchangeRate"/);
  assert.match(rulesPage, /class="\$\{selectedRuleLineIndex === index \? "is-selected" : ""\}"/);
  assert.match(source, /\["fixed", "固定值"\]/);
  assert.match(source, /\["field", "来源字段"\]/);
  assert.match(source, /\["calculation", "简单计算"\]/);
  assert.match(source, /data-rule-line-account-source/);
  assert.match(source, /审批数据处理 · 科目/);
  assert.match(source, /\["defaultRateType", "金蝶默认汇率类型"\]/);
  assert.match(source, /exchangeRateType", "业务数据中的汇率类型（高级）"/);
  assert.match(source, /kingdeeExchangeRate", "金蝶汇率体系匹配"/);
  assert.match(source, /function normalizeExchangeRateTypeSpec\(spec\)/);
  assert.match(source, /exchangeRateType: normalizeExchangeRateTypeSpec\(merged\.exchangeRateType\)/);
  assert.match(source, /kind === "exchangeRateType"\s*\?\s*normalizeExchangeRateTypeSpec\(spec\)/);
  assert.match(source, /data-insert-summary-token/);
  assert.match(source, /data-add-rule-line/);
  assert.match(source, /data-insert-rule-line/);
  assert.match(source, /data-delete-rule-line/);
  assert.match(source, /AUXILIARY_DIMENSION_CATALOG/);
  assert.match(source, /data-rule-dimension-key/);
  assert.match(source, /data-add-rule-dimension/);
  assert.match(source, /data-remove-rule-dimension/);
  assert.match(source, /来源供应商 \/ 客户 \/ 对方单位/);
  assert.match(styles, /\.rule-entry-table\s*\{/);
  assert.match(styles, /\.rule-config-section\[hidden\]/);
  assert.match(styles, /\.rule-preview-panel\s*\{/);
});

test("master data uses a filtered paginated semantic table", () => {
  assert.match(source, /class="master-data-commandbar"/);
  assert.match(source, /class="master-data-titleline"/);
  assert.match(source, /class="master-data-count"/);
  assert.match(source, /data-master-filter-form/);
  assert.match(source, /role="tablist" aria-label="基础资料分类"/);
  assert.match(source, /data-master-category="all"/);
  assert.match(source, /data-master-category=/);
  assert.match(source, /categoryCounts/);
  assert.match(source, /name="source"/);
  assert.match(source, /name="status"/);
  assert.match(source, /name="search"/);
  assert.match(source, /<table class="account-master-table master-data-table" aria-label="基础资料表">/);
  assert.match(source, /<thead>[\s\S]*<tbody>/);
  assert.match(source, /<tr class="account-master-row" data-account-row=/);
  assert.match(source, /data-master-page=/);
  assert.match(source, /MASTER_DATA_PAGE_SIZE = 50/);
  assert.doesNotMatch(source, /class="master-data-summary"/);
  assert.doesNotMatch(source, /条匹配记录/);
  assert.doesNotMatch(source, /class="account-master-head"/);
  assert.doesNotMatch(source, /class="account-master-list"/);
});
