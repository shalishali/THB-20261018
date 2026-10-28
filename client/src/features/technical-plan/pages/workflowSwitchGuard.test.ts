import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./TechnicalPlanHome.tsx', import.meta.url), 'utf8');

function callbackBody(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback`);
  assert.notEqual(start, -1, `未找到 ${name}`);
  const end = source.indexOf('\n  }, [', start);
  assert.notEqual(end, -1, `未找到 ${name} 的依赖数组`);
  return source.slice(start, end);
}

test('工作流切换必须先请求确认，不能静默执行', () => {
  const body = callbackBody('openWorkflowSwitchDialog');
  assert.match(body, /setWorkflowSwitchRequest\(\{/);
  assert.doesNotMatch(body, /executeWorkflowSwitch\(/);
});

test('工作流切换确认弹窗仍有确认与取消处理', () => {
  assert.match(source, /const confirmWorkflowSwitch = async \(\) => \{/);
  assert.match(source, /const cancelWorkflowSwitch = \(\) => \{/);
  assert.match(source, /确认切换到/);
});
