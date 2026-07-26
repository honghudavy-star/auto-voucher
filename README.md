# Auto Voucher

Auto Voucher 是一款本地优先的凭证自动化工作台，用于读取业务资料、生成可审核的凭证草稿、集中处理异常、人工确认后推送，并查询本地凭证、账簿汇总与审计记录。

当前仓库只提供生产模式，不创建示例公司、示例账簿、演示连接器或默认审批结果。官网不在本仓库中，本仓库保留核心程序、轻量启动器、测试和产品文档。

## 已实现

- 暖珊瑚透明毛玻璃空间工作台；
- CSV/XLSX/数电发票 XML、XBRL 和 OFD 内嵌结构化数据导入、SHA-256 去重和部分失败隔离；OFD 电子签名未验证时保持阻断；
- 未知 CSV/XLSX 表头预览、字段映射和可复用模板；
- 文本型 PDF 本地文本提取；扫描 PDF/图片本地 OCR 候选提取、置信度标记与人工确认；
- 采购付款业务事项创建、同一业务键资料归并、金额差异与来源占用保护；
- 整数分金额计算、结构化确定性规则、冲突解释、优先级匹配、规则新版本和历史引用；
- 凭证草稿生成、借贷校验和规则解释；
- 凭证草稿分录编辑、重新校验和操作者审计；
- 阻断异常、人工解决和重新校验；
- 人工确认、通用凭证 XLSX 导出；
- 飞书审批 v4 增量同步适配器：只接收明确审批通过实例，按控件 ID 映射、游标续跑并归档源系统原始 JSON 响应；
- 金蝶云·星空、用友 U8 V12+、浪潮海岳 GS Cloud 统一适配合同：能力探测、主数据同步、期间检查、只保存凭证草稿、幂等回查；
- 连接器配置表单、操作系统密钥库、测试/生产环境锁、推送前逐项校验和厂商错误分类；
- 本地凭证、科目汇总和服务端强制只追加的审计时间线；
- 面向财务人员的诊断日志中心：结构化事件、支持编号、级别/模块/时间筛选、单条或当前页复制、自动脱敏和诊断 ZIP 导出；
- 按连接器能力启用外部凭证、账簿和三大财务报表只读查询，明确显示目标环境、数据来源和缓存时间；
- 导入与连接器同步后台任务、批量生成逐项持久化和中断续跑；
- 操作者设置、操作系统密钥库存储接口、日志脱敏、包含原件的完整性校验 ZIP 备份和恢复；
- SQLite 本地持久化和内容寻址文件归档；
- 零 Web 框架的本地 HTTP 服务，强制仅监听回环地址。
- Windows 原生 Go 轻量启动器：在线首次安装、签名清单、断点续传、独立版本目录、健康检查和失败回退；
- 环境检测、白名单自修复、按需 OCR/PDF 组件、后台更新状态和一键复制脱敏问题信息。

## 本地运行

以下依赖只面向开发者。正式 Windows 用户只需双击轻量启动器，不需要安装 Node.js、Python 或执行命令。开发需要 Node.js 20+、Python 3.11+；OCR 使用可选依赖。

```bash
npm install
npm run setup:python
npm start
```

程序会构建前端、启动本地服务并打开 `http://127.0.0.1:8765/`。默认数据目录：

- macOS：`~/Library/Application Support/Auto Voucher`
- Windows：`%LOCALAPPDATA%/Auto Voucher`
- Linux：`~/.local/share/auto-voucher`

开发时可分别启动 API 和 Vite：

```bash
npm run serve
npm run dev
```

运行测试和生产构建：

```bash
npm run check
```

## 导入模板

在应用的“导入数据”页面下载模板，或参考：

```csv
业务日期,供应商,含税金额,审批单号,部门,项目,摘要
2026-07-24,待配置供应商,12800.00,APPROVAL-0001,待配置部门,待配置项目,采购原材料
```

## 已确认的开发边界

- CSV、XLSX 和通用字段型数电发票 XML 已支持真实解析；不同税控厂商 XML 仍需以样本扩充字段映射。
- 文本型 PDF 可使用本机 `pdftotext` 提取可搜索文本；扫描 PDF 和图片使用本地 RapidOCR 生成候选字段，日期、主体、金额、发票号和税号经人工确认后才创建业务事项。
- SQLite 是正式数据源；浏览器端不提供脱离本地服务的演示数据兜底。
- 飞书、金蝶、用友和浪潮适配器已实现接口合同与自动化合同测试；尚未取得客户真实测试租户/账套，不能据此宣称厂商环境已经验收。
- 查询中心的科目余额为本地已确认凭证汇总，明确标记为本地预估数据，不代表正式财务报表。
- 连接器密钥只能写入操作系统密钥库，不进入 SQLite、日志或备份；生产环境切换和推送都需要显式确认。
- 产品仅提供桌面 Web 工作台，最小内容宽度为 1180px；移动端不是产品范围。
- 诊断日志与财务审计日志相互独立；诊断包不包含原始票据、凭证分录、数据库或密钥，详细边界见 [诊断日志与技术支持](docs/诊断日志与技术支持.md)。

## Windows 轻量启动器与更新

仓库提供 Go 启动器、PyInstaller 核心/可选 OCR 与 PDF 组件、Inno Setup 引导包和 Windows CI：

```text
.github/workflows/windows-installer.yml
packaging/auto-voucher.spec
packaging/AutoVoucher.iss
```

Python 运行依赖、可选组件和 PyInstaller 由 `uv.lock` 固定；GitHub Actions、Wrangler、pip、uv 与 Inno Setup 也固定到明确版本。正式发布必须配置：

- Secrets：`AUTO_VOUCHER_RELEASE_PRIVATE_KEY`、`WINDOWS_CERTIFICATE_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；
- Variables：`AUTO_VOUCHER_CORE_BASE_URL`、`AUTO_VOUCHER_R2_BUCKET`、`AUTO_VOUCHER_PUBLIC_UPDATE_BASE_URL`。

手动运行可以只生成未发布候选包；选择 `publish=true` 或推送与项目版本完全一致的 `v*` tag 才会进入正式签名和 R2 发布。发布顺序固定为版本化程序包、启动器、安装器、清单签名、清单，全部公开读取校验通过后才更新：

```text
<PUBLIC_UPDATE_BASE_URL>/downloads/<pilot|stable>/AutoVoucher-Setup-windows-x64.exe
```

更新前备份 SQLite；新核心未通过健康检查时，启动器会先原子恢复经过 SHA-256 校验的数据库备份，再启动旧核心，并保留失败数据库副本用于诊断。没有正式凭据时 CI 必须失败，不会生成可冒充正式发布的产物。

P0 发布前仍需在干净 Windows 10 22H2 / Windows 11 x64 完成首次在线安装、离线重启、连续两次升级、故障注入回退、备份恢复和卸载验收。
完整发布、灰度和事故回退步骤见 [Windows 发版清单](docs/Windows发版清单.md)。

## License

本项目采用 [Apache License 2.0](LICENSE) 开源。
