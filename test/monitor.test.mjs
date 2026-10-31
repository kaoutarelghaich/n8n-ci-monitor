import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { acknowledgeAlerts, prepareConfig, selectAlerts } from '../src/monitor.mjs';

const now = Date.parse('2026-10-31T10:00:00Z');
const settings = { owner: 'octocat', repo: 'hello-world', channel: 'C1234567890', lookbackHours: 24 };
const config = prepareConfig(settings, now);
const run = (overrides = {}) => ({
  id: 123456,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'failure',
  updated_at: '2026-10-31T09:00:00Z',
  created_at: '2020-01-01T00:00:00Z',
  name: 'Build',
  head_branch: 'main',
  head_sha: '0123456789abcdef',
  actor: { login: 'octocat' },
  ...overrides,
});
const page = (...runs) => ({ total_count: runs.length, workflow_runs: runs });
const delivered = () => ({ ok: true, channel: settings.channel, ts: '1793437200.000001' });

test('validates and normalizes configuration before making requests', () => {
  assert.equal(prepareConfig({ ...settings, owner: ' OctoCat ', repo: ' Hello-World ' }, now).apiUrl,
    'https://api.github.com/repos/octocat/hello-world/actions/runs');
  for (const overrides of [
    { owner: 'your-owner' }, { owner: '' }, { owner: 'octocat/evil' },
    { repo: 'your-repo' }, { repo: '..' }, { repo: 'repo?token=abc' },
    { channel: '#alerts' }, { channel: 'C0123456789' },
    { lookbackHours: 0 }, { lookbackHours: 169 }, { lookbackHours: 1.5 },
    { lookbackHours: '24' },
  ]) {
    assert.throws(() => prepareConfig({ ...settings, ...overrides }, now));
  }
  for (const lookbackHours of [1, 168]) {
    assert.equal(prepareConfig({ ...settings, lookbackHours }, now).lookbackHours, lookbackHours);
  }
});

test('selects supported failures across pages and includes recent reruns of old workflows', () => {
  const result = selectAlerts([
    page(run(), run({ id: 2, conclusion: 'success' }), run({ id: 3, status: 'in_progress' })),
    page(run({ id: 4, conclusion: 'timed_out' }), run({ id: 5, conclusion: 'startup_failure' })),
  ], config, {});
  assert.equal(result.length, 3);
  assert.ok(result.some((alert) => alert.key.endsWith(':123456:1')));
  assert.ok(result[0].slackBody.text.includes('https://github.com/octocat/hello-world/actions/runs/'));
});

test('ignores non-failures, old runs, and empty repositories without sending a Slack item', () => {
  assert.deepEqual(selectAlerts([page()], config, {}), []);
  assert.deepEqual(selectAlerts([page(
    ...['success', 'cancelled', 'skipped', 'neutral', 'action_required', 'stale']
      .map((conclusion, id) => run({ conclusion, id: id + 1 })),
    run({ updated_at: '2026-10-30T09:59:59.999Z' }),
  )], config, {}), []);
});

test('includes the exact lookback boundary and sorts older failures first', () => {
  const result = selectAlerts([page(run(), run({
    id: 1, updated_at: new Date(config.windowStart).toISOString(),
  }))], config, {});
  assert.equal(result.length, 2);
  assert.ok(result[0].key.endsWith(':1:1'));
});

test('deduplicates pages and delivered attempts but alerts for a new attempt or channel', () => {
  const state = {};
  const alerts = selectAlerts([page(run()), page(run())], config, state);
  assert.equal(alerts.length, 1);
  assert.deepEqual(state, {});
  acknowledgeAlerts([delivered()], alerts, config, state);
  assert.deepEqual(selectAlerts([page(run())], config, state), []);
  assert.equal(selectAlerts([page(run({ run_attempt: 2 }))], config, state).length, 1);
  assert.equal(selectAlerts([page(run())], { ...config, channel: 'C9999999999' }, state).length, 1);
});

test('escapes untrusted Slack markup and keeps message length bounded', () => {
  const [alert] = selectAlerts([page(run({
    name: '<!channel>\n<@U1234567890> & ' + 'x'.repeat(10000),
    head_branch: '<https://example.com|click>',
  }))], config, {});
  assert.equal(alert.slackBody.mrkdwn, false);
  assert.equal(alert.slackBody.parse, 'none');
  assert.equal(alert.slackBody.unfurl_links, false);
  assert.ok(!alert.slackBody.text.includes('<!channel>'));
  assert.ok(alert.slackBody.text.includes('&lt;!channel&gt;'));
  assert.ok(alert.slackBody.text.length < 4000);
});

test('rejects malformed GitHub responses and corrupt state', () => {
  for (const pages of [
    [], [{}], [{ workflow_runs: [], total_count: '0' }],
    [page(null)], [page(run({ id: '123' }))], [page(run({ run_attempt: 0 }))],
    [page(run({ updated_at: 'bad-date' }))],
  ]) {
    assert.throws(() => selectAlerts(pages, config, {}));
  }
  assert.throws(() => selectAlerts([page(run())], config, { sent: [] }));
  assert.throws(() => selectAlerts([page(run())], config, { sent: { key: 'bad timestamp' } }));
});

test('never acknowledges partial delivery or Slack HTTP-200 errors', () => {
  const alerts = selectAlerts([page(run(), run({ id: 2 }))], config, {});
  for (const responses of [
    [delivered()],
    [delivered(), { ok: false, error: 'not_in_channel' }],
    [delivered(), { ...delivered(), channel: 'C9999999999' }],
    [delivered(), { ok: true }],
  ]) {
    const state = { sent: { previous: now } };
    assert.throws(() => acknowledgeAlerts(responses, alerts, config, state));
    assert.deepEqual(state, { sent: { previous: now } });
  }
});

test('acknowledges all successful deliveries and prunes expired state', () => {
  const state = { sent: { expired: config.windowStart - 1, current: config.windowStart } };
  const alerts = selectAlerts([page(run())], config, state);
  assert.deepEqual(acknowledgeAlerts([delivered()], alerts, config, state), [
    { json: { delivered: 1, channel: settings.channel } },
  ]);
  assert.equal(state.sent.expired, undefined);
  assert.equal(state.sent.current, config.windowStart);
  assert.equal(state.sent[alerts[0].key], Date.parse(run().updated_at));
});

const workflow = JSON.parse(await readFile(new URL('../workflows/ci-monitor.json', import.meta.url), 'utf8'));
const node = (name) => workflow.nodes.find((item) => item.name === name);
function executeCode(name, input, upstream, state) {
  return runInNewContext(`(function () { ${node(name).parameters.jsCode} })()`, {
    $input: { first: () => input[0], all: () => input },
    $: (name) => ({ first: () => upstream[name][0], all: () => upstream[name] }),
    $getWorkflowStaticData: () => state,
    Date: class extends Date { static now() { return now; } },
  }, { timeout: 1000 });
}

test('exported Code nodes execute the complete selection and acknowledgement pipeline', () => {
  const validated = executeCode('Validate settings', [{ json: settings }], {}, {});
  const upstream = { 'Validate settings': validated };
  const state = {};
  const alerts = executeCode('Select new failures', [{ json: page(run()) }], upstream, state);
  assert.equal(alerts.length, 1);
  upstream['Select new failures'] = alerts;
  const result = executeCode('Confirm delivery', [{ json: delivered() }], upstream, state);
  assert.equal(result[0].json.delivered, 1);
  assert.equal(executeCode('Select new failures', [{ json: page(run()) }], upstream, state).length, 0);
});

test('workflow wiring is complete, inactive, credential-free, and failure-preserving', () => {
  assert.equal(workflow.active, false);
  const names = new Set(workflow.nodes.map((item) => item.name));
  assert.equal(names.size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map((item) => item.id)).size, workflow.nodes.length);
  for (const [source, connection] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source));
    for (const target of connection.main.flat()) assert.ok(names.has(target.node));
  }
  for (const item of workflow.nodes) {
    assert.equal(item.credentials, undefined);
    assert.notEqual(item.continueOnFail, true);
    assert.notEqual(item.alwaysOutputData, true);
  }
  const pagination = node('Fetch workflow runs').parameters.options.pagination.pagination;
  assert.equal(pagination.limitPagesFetched, false);
  assert.equal(node('Fetch workflow runs').parameters.nodeCredentialType, 'githubApi');
  assert.equal(node('Send Slack alert').parameters.nodeCredentialType, 'slackApi');
  assert.equal(node('Send Slack alert').retryOnFail, undefined);
  assert.equal(node('Every 5 minutes').parameters.rule.interval[0].minutesInterval, 5);
  assert.equal(workflow.connections['Send Slack alert'].main[0][0].node, 'Confirm delivery');
});

test('pagination requests page one then subsequent pages and stops only after a short page', () => {
  const pagination = node('Fetch workflow runs').parameters.options.pagination.pagination;
  const expression = (value, scope) => runInNewContext(value.slice(3, -2).trim(), scope);
  const pageExpression = pagination.parameters.parameters[0].value;
  assert.equal(expression(pageExpression, { $pageCount: 0 }), 1);
  assert.equal(expression(pageExpression, { $pageCount: 2 }), 3);
  for (const length of [0, 1, 99, 100]) {
    assert.equal(expression(pagination.completeExpression, {
      $response: { body: { workflow_runs: Array.from({ length }, () => run()) } },
    }), length < 100);
  }
  assert.throws(() => expression(pagination.completeExpression, { $response: { body: {} } }));
});
