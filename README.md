# Auto Voucher

Auto Voucher 是一个开源、本地优先的财务凭证自动化工作台。它将业务资料导入、事项识别、凭证草稿生成、人工复核、ERP 推送和审计追踪整合在同一套流程中。

数据默认保存在用户本机。系统只生成和保存凭证草稿，不自动提交、审核、过账或结账。

## Windows 源码运行

目前不再向新用户提供未签名的 EXE 安装包。Windows 用户下载专用源码包即可：

- [下载 Auto Voucher Windows 源码包](https://github.com/honghudavy-star/auto-voucher/releases/latest/download/Auto-Voucher-Windows.zip)

使用方式：

1. 解压下载的 ZIP；
2. 最外层只有 **`Start-Auto-Voucher.bat`** 和内部程序文件夹；
3. 双击 **`Start-Auto-Voucher.bat`**，浏览器会立即打开本地环境配置页面；
4. 点击 **“自动安装环境并继续”**，等待页面显示环境成功并自动进入工作台。

配置页会明确显示 Node.js 与 Python 是否就绪。缺少组件时不再要求用户自行下载或选择安装路径：页面上的按钮会下载固定的官方版本、校验 SHA-256，并将 Node.js 与 Python 配置在项目内部；失败时可直接重试，成功后才会继续安装 Core、OCR、PDF 全部组件。后续运行会复用现有环境。BAT 每次启动也会检查更高的源码版本；更新失败时继续运行当前版本，不影响已有环境下的离线启动。程序准备完成后会自动进入工作台；如果没有自动进入，请访问：

```text
http://127.0.0.1:8765/
```

## 主要功能

- 导入 CSV、TXT、XLS、XLSX、XML、XBRL、OFD、PDF、图片和银行流水；
- 内置《小企业会计准则》（财会〔2011〕17号）66 个默认科目，支持修改、增删、恢复默认以及导入企业科目表；
- 基于确定性规则生成借贷平衡的凭证草稿；
- 校验科目、供应商、客户、部门、项目和辅助核算；
- 支持异常阻断、人工复核、操作审计和幂等回查；
- 提供飞书审批，以及金蝶云星空、用友 U8、浪潮海岳 GS Cloud 适配器框架；
- 支持 ERP API 直连或按客户模板导出；
- 历史 Windows 启动器代码保留用于已有版本维护，新用户通过源码运行；
- 一键复制脱敏诊断信息，不自动上传业务数据。

## 工作流程

工作台包含五个一级入口：

1. **接入方案**：选择企业、目标 ERP、数据来源和业务场景；
2. **系统与数据**：配置连接器、模板、账套和基础资料；
3. **凭证规则**：维护字段映射、会计分录和异常规则；
4. **测试上线**：完成连接、期间、主数据、草稿和回查验证；
5. **凭证工作台**：导入资料、生成凭证、复核、推送和查询。

未完成测试上线门槛时，生产导出和推送保持禁用。

## macOS / Linux 本地开发

需要 Node.js 20+、Python 3.11+。

```bash
git clone https://github.com/honghudavy-star/auto-voucher.git
cd auto-voucher
npm install
npm run setup:python
npm start
```

启动后访问：

```text
http://127.0.0.1:8765/
```

运行完整检查：

```bash
npm run check
```

OCR 和 PDF 识别是可选组件：

```bash
python3 -m pip install -e ".[ocr,pdf]"
```

## 项目结构

```text
backend/      本地服务、SQLite、导入、规则和连接器
src/          浏览器工作台
launcher/     Windows Go 轻量启动器
packaging/    PyInstaller 与 Inno Setup 打包配置
tests/        前端领域测试
docs/         架构、诊断和发布文档
```

## 当前边界

- ERP 适配器已完成统一接口与自动化合同测试，真实客户环境仍需使用客户提供的版本、接口文档和测试账套验收；
- 文件上传不等于审批通过，审批、资料验证、财务复核和允许推送是独立状态；
- 扫描件识别结果只作为候选数据，必须经过人工确认；
- 密钥仅写入操作系统密钥库，不进入 SQLite、日志或备份；
- Windows 源码包会在本地配置页自动准备 Node.js 与 Python；现阶段不再将未签名 EXE 作为新用户下载入口。

更多信息：

- [系统架构](docs/architecture.md)
- [诊断日志与技术支持](docs/诊断日志与技术支持.md)
- [Windows 发版清单](docs/Windows发版清单.md)
- [v0.2.2 发布说明](docs/v0.2.2发布说明.md)
- [v0.2.0 发布说明](docs/v0.2.0发布说明.md)
- [长视频讲解与宣传脚本](docs/Auto-Voucher长视频讲解与宣传脚本.md)
- [小红书文案与实机录屏脚本](docs/小红书与实机录屏文案.md)
- [产品需求说明](specs/auto-voucher-prd.spec.md)

## 参与贡献

欢迎提交 Issue 和 Pull Request。涉及财务规则、ERP 字段或生产推送的改动，请同时提供测试用例，并说明适用产品、版本和验证环境。

## License

本项目采用 [Apache License 2.0](LICENSE)。
