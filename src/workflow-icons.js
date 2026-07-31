import bankDataIcon from "~icons/fluent-color/coin-multiple-24?raw&width=24&height=24";
import businessDataIcon from "~icons/fluent-color/briefcase-24?raw&width=24&height=24";
import approvalDataIcon from "~icons/fluent-color/approvals-app-24?raw&width=24&height=24";
import depreciationDataIcon from "~icons/fluent-color/calendar-data-bar-24?raw&width=24&height=24";
import masterDataMatchIcon from "~icons/fluent-color/book-database-24?raw&width=24&height=24";
import businessFilterIcon from "~icons/fluent-color/search-sparkle-24?raw&width=24&height=24";
import bankFilterIcon from "~icons/fluent-color/data-bar-vertical-ascending-24?raw&width=24&height=24";
import approvalProcessingIcon from "~icons/fluent-color/clipboard-task-24?raw&width=24&height=24";
import depreciationProcessingIcon from "~icons/fluent-color/calendar-sync-24?raw&width=24&height=24";
import voucherRulesIcon from "~icons/fluent-color/options-24?raw&width=24&height=24";
import exceptionHandlingIcon from "~icons/fluent-color/warning-24?raw&width=24&height=24";
import voucherGenerationIcon from "~icons/fluent-color/document-add-24?raw&width=24&height=24";
import erpOutputIcon from "~icons/fluent-color/cloud-24?raw&width=24&height=24";
import voucherTemplateIcon from "~icons/fluent-color/table-24?raw&width=24&height=24";

const workflowNodeIcons = Object.freeze({
  "source-bank": bankDataIcon,
  "source-business": businessDataIcon,
  "source-approval": approvalDataIcon,
  "source-depreciation": depreciationDataIcon,
  "process-systems": masterDataMatchIcon,
  "process-business": businessFilterIcon,
  "process-bank": bankFilterIcon,
  "process-approval": approvalProcessingIcon,
  "process-depreciation": depreciationProcessingIcon,
  "process-rules": voucherRulesIcon,
  "process-exceptions": exceptionHandlingIcon,
  "process-vouchers": voucherGenerationIcon,
  "output-erp": erpOutputIcon,
  "output-template": voucherTemplateIcon,
});

export function workflowNodeIcon(nodeId) {
  return workflowNodeIcons[nodeId] || "";
}
