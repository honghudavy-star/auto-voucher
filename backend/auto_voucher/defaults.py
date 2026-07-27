from __future__ import annotations

import uuid
from copy import deepcopy
from typing import Any


DEFAULT_ACCOUNT_SOURCE = {
    "title": "小企业会计准则——会计科目、主要账务处理和财务报表",
    "documentNumber": "财会〔2011〕17号",
    "effectiveDate": "2013-01-01",
    "knowledgeBasePath": "accounting/se/cass/appendix.md",
}


_DEFAULT_ACCOUNTS = (
    ("1001", "库存现金"), ("1002", "银行存款"), ("1012", "其他货币资金"),
    ("1101", "短期投资"), ("1121", "应收票据"), ("1122", "应收账款"),
    ("1123", "预付账款"), ("1131", "应收股利"), ("1132", "应收利息"),
    ("1221", "其他应收款"), ("1401", "材料采购"), ("1402", "在途物资"),
    ("1403", "原材料"), ("1404", "材料成本差异"), ("1405", "库存商品"),
    ("1407", "商品进销差价"), ("1408", "委托加工物资"), ("1411", "周转材料"),
    ("1421", "消耗性生物资产"), ("1501", "长期债券投资"), ("1511", "长期股权投资"),
    ("1601", "固定资产"), ("1602", "累计折旧"), ("1604", "在建工程"),
    ("1605", "工程物资"), ("1606", "固定资产清理"), ("1621", "生产性生物资产"),
    ("1622", "生产性生物资产累计折旧"), ("1701", "无形资产"), ("1702", "累计摊销"),
    ("1801", "长期待摊费用"), ("1901", "待处理财产损溢"),
    ("2001", "短期借款"), ("2201", "应付票据"), ("2202", "应付账款"),
    ("2203", "预收账款"), ("2211", "应付职工薪酬"), ("2221", "应交税费"),
    ("2231", "应付利息"), ("2232", "应付利润"), ("2241", "其他应付款"),
    ("2401", "递延收益"), ("2501", "长期借款"), ("2701", "长期应付款"),
    ("3001", "实收资本"), ("3002", "资本公积"), ("3101", "盈余公积"),
    ("3103", "本年利润"), ("3104", "利润分配"),
    ("4001", "生产成本"), ("4101", "制造费用"), ("4301", "研发支出"),
    ("4401", "工程施工"), ("4403", "机械作业"),
    ("5001", "主营业务收入"), ("5051", "其他业务收入"), ("5111", "投资收益"),
    ("5301", "营业外收入"), ("5401", "主营业务成本"), ("5402", "其他业务成本"),
    ("5403", "营业税金及附加"), ("5601", "销售费用"), ("5602", "管理费用"),
    ("5603", "财务费用"), ("5711", "营业外支出"), ("5801", "所得税费用"),
)


def account_group(code: str) -> str:
    return {
        "1": "资产类",
        "2": "负债类",
        "3": "所有者权益类",
        "4": "成本类",
        "5": "损益类",
    }.get(code[:1], "")


def account_normal_balance(code: str) -> str:
    if code[:1] in {"1", "4"} or code.startswith(("54", "56", "57", "58")):
        return "借"
    return "贷"


def default_account_master_data() -> list[dict[str, Any]]:
    return [
        {
            "id": f"MD-DEFAULT-ACCOUNT-{code}",
            "category": "account",
            "categoryLabel": "科目",
            "code": code,
            "name": name,
            "group": account_group(code),
            "normalBalance": account_normal_balance(code),
            "status": "启用",
            "requiredDimensions": [],
            "version": 1,
            "active": True,
            "source": "内置默认",
            "sourceReference": deepcopy(DEFAULT_ACCOUNT_SOURCE),
        }
        for code, name in _DEFAULT_ACCOUNTS
    ]


def initialize_default_accounts(state: dict[str, Any]) -> bool:
    if state.get("defaultAccountsInitialized"):
        return False
    master_data = state.setdefault("masterData", [])
    if not any(item.get("category") == "account" and item.get("active", True) for item in master_data):
        master_data.extend(default_account_master_data())
    state["defaultAccountsInitialized"] = True
    state["defaultAccountSource"] = deepcopy(DEFAULT_ACCOUNT_SOURCE)
    return True


def restore_default_accounts(state: dict[str, Any], changed_at: str) -> int:
    master_data = state.setdefault("masterData", [])
    for item in master_data:
        if item.get("category") == "account" and item.get("active", True):
            item["active"] = False
            item["supersededAt"] = changed_at
    restored = default_account_master_data()
    for item in restored:
        prior_versions = [
            int(current.get("version") or 0)
            for current in master_data
            if current.get("category") == "account" and current.get("code") == item["code"]
        ]
        item["id"] = f"MD-DEFAULT-ACCOUNT-{item['code']}-{uuid.uuid4().hex[:8].upper()}"
        item["version"] = max(prior_versions, default=0) + 1
        item["restoredAt"] = changed_at
    master_data.extend(restored)
    state["defaultAccountsInitialized"] = True
    state["defaultAccountSource"] = deepcopy(DEFAULT_ACCOUNT_SOURCE)
    return len(_DEFAULT_ACCOUNTS)
