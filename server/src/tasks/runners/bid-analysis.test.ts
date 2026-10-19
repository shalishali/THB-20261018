import assert from 'node:assert/strict';
import test from 'node:test';

const { extractProjectNameFromProjectInfo } = await import('./bid-analysis');

// STEP02（招标解析）完成后，仪表盘项目名应从 projectInfo 提取出的项目名称回填；
// 未提取到（或模型回「没有提及」）时保持编号占位，不用文件名兜底。
test('projectInfo 标准 JSON：提取 project_name', () => {
  const raw = '{"project_name":"壤塘县农光互补中药材-羌活种植项目","project_number":"XM-001","project_type":"工程"}';
  assert.equal(extractProjectNameFromProjectInfo(raw), '壤塘县农光互补中药材-羌活种植项目');
});

test('projectInfo JSON 围栏/前后带说明文字也能提取', () => {
  const raw = '```json\n{"project_name":"某某县光伏项目","project_number":"A1"}\n```';
  assert.equal(extractProjectNameFromProjectInfo(raw), '某某县光伏项目');
  const withProse = '解析结果如下：\n{"project_name":"带说明文字的项目","project_number":"B2"}\n以上。';
  assert.equal(extractProjectNameFromProjectInfo(withProse), '带说明文字的项目');
});

test('projectInfo 历史 Markdown 格式兼容', () => {
  assert.equal(extractProjectNameFromProjectInfo('- **项目名称**：某某市政道路工程\n- 项目编号：C3'), '某某市政道路工程');
  assert.equal(extractProjectNameFromProjectInfo('| 项目名称 | 某某水利工程 |\n| 项目编号 | D4 |'), '某某水利工程');
});

test('未提取到（「没有提及」/空）返回 null，保持编号占位', () => {
  assert.equal(extractProjectNameFromProjectInfo('{"project_name":"没有提及"}'), null);
  assert.equal(extractProjectNameFromProjectInfo('{"project_number":"E5"}'), null);
  assert.equal(extractProjectNameFromProjectInfo(''), null);
  assert.equal(extractProjectNameFromProjectInfo('随便一段没有项目名称的话'), null);
});
