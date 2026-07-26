# Auto Voucher

Auto Voucher 是一个开源、本地优先的财务凭证自动化工作台。它将业务资料导入、事项识别、凭证草稿生成、人工复核、ERP 推送和审计追踪整合在同一套流程中。

数据默认保存在用户本机。系统只生成和保存凭证草稿，不自动提交、审核、过账或结账。

## 下载

Windows 10 22H2 / Windows 11 x64 用户可下载轻量安装器：

- [下载 Auto Voucher 稳定版](https://updates.iagent7.com/auto-voucher/stable/AutoVoucher-Setup-windows-x64.exe)

当前安装器未使用 Authenticode 代码签名，Windows 可能显示“未知发布者”。请只从本仓库或上述官方地址下载，并在安装前核对 [GitHub Release](https://github.com/honghudavy-star/auto-voucher/releases) 中公布的 SHA-256。

## 主要功能

- 导入 CSV、XLSX、XML、XBRL、OFD、PDF、图片和银行流水；
- 基于确定性规则生成借贷平衡的凭证草稿；
- 校验科目、供应商、客户、部门、项目和辅助核算；
- 支持异常阻断、人工复核、操作审计和幂等回查；
- 提供飞书审批，以及金蝶云星空、用友 U8、浪潮海岳 GS Cloud 适配器框架；
- 支持 ERP API 直连或按客户模板导出；
- 提供 Windows 轻量启动器、环境检测、自动更新和失败回退；
- 一键复制脱敏诊断信息，不自动上传业务数据。

## 工作流程

工作台包含五个一级入口：

1. **接入方案**：选择企业、目标 ERP、数据来源和业务场景；
2. **系统与数据**：配置连接器、模板、账套和基础资料；
3. **凭证规则**：维护字段映射、会计分录和异常规则；
4. **测试上线**：完成连接、期间、主数据、草稿和回查验证；
5. **凭证工作台**：导入资料、生成凭证、复核、推送和查询。

未完成测试上线门槛时，生产导出和推送保持禁用。

## 本地开发

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
- Windows 正式发布采用未签名 EXE；仍要求更新清单签名、SHA-256 校验及干净 Windows 10/11 x64 环境验收。

更多信息：

- [系统架构](docs/architecture.md)
- [诊断日志与技术支持](docs/诊断日志与技术支持.md)
- [Windows 发版清单](docs/Windows发版清单.md)
- [v0.2.2 发布说明](docs/v0.2.2发布说明.md)
- [v0.2.0 发布说明](docs/v0.2.0发布说明.md)
- [长视频讲解与宣传脚本](docs/Auto-Voucher长视频讲解与宣传脚本.md)
- [产品需求说明](specs/auto-voucher-prd.spec.md)

## 参与贡献

欢迎提交 Issue 和 Pull Request。涉及财务规则、ERP 字段或生产推送的改动，请同时提供测试用例，并说明适用产品、版本和验证环境。

## License

本项目采用 [Apache License 2.0](LICENSE)。
