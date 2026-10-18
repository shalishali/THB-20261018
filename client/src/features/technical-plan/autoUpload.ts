// 仪表盘"上传招标文件"直达流：跨页面传递"进入 STEP01 后自动弹出文件选择窗口"的标记。
// 仪表盘创建项目后置位，DocumentAnalysisPage 挂载时消费并触发 importTenderDocument，
// 用户无需再点一次"上传"。单次消费：置位后首次进入 STEP01 即清除，不影响后续手动上传。
let pending = false;

export function markPendingAutoUpload(): void {
  pending = true;
}

export function consumePendingAutoUpload(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}
