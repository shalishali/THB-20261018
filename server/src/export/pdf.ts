// 已下线（2026-10-18）：PDF 导出功能不再提供（产品决策）。
//
// 原实现：docx Buffer → LibreOffice --headless --convert-to pdf → PDF Buffer，
// 由 POST /api/export/pdf 调用（API-33 / FE-24）。
//
// 移除原因与影响：
//   - 导出只保留 Word（/api/export/word）。PDF 解析能力不受影响，仍由
//     document/doc2markdown/convert.mjs 负责（pdf-parse + pdfjs-dist）。
//   - 本文件保留为空壳仅作历史标记；若确认无外部引用可整文件删除。
