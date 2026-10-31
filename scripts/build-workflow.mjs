import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  acknowledgeAlerts,
  prepareConfig,
  readSent,
  selectAlerts,
  slackText,
} from '../src/monitor.mjs';

const code = (functions, body) => `${functions.map((fn) => fn.toString()).join('\n\n')}\n\n${body}\n`;
const workflow = {
  name: 'CI Sentinel - GitHub Actions to Slack',
  active: false,
  nodes: [
    {
      id: 'setup-note',
      name: 'Setup guide',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [0, -300],
      parameters: {
        content: '## CI Sentinel\n1. Edit **Monitor settings**.\n2. Select GitHub API credentials in **Fetch workflow runs**.\n3. Select Slack API credentials in **Send Slack alert**.\n4. Test once, then publish/activate.\n\nEvery 5 minutes. Failed attempts from the last 24 hours. Manual tests send real messages but do not persist deduplication. See README for delivery guarantees.',
        height: 260,
        width: 580,
      },
    },
    {
      id: 'manual-trigger',
      name: 'Test manually',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 100],
      parameters: {},
    },
    {
      id: 'schedule-trigger',
      name: 'Every 5 minutes',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 300],
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } },
    },
    {
      id: 'monitor-settings',
      name: 'Monitor settings',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [240, 200],
      parameters: {
        assignments: {
          assignments: [
            { id: 'owner', name: 'owner', value: 'your-owner', type: 'string' },
            { id: 'repo', name: 'repo', value: 'your-repo', type: 'string' },
            { id: 'channel', name: 'channel', value: 'C0123456789', type: 'string' },
            { id: 'lookback', name: 'lookbackHours', value: 24, type: 'number' },
          ],
        },
        options: {},
      },
    },
    {
      id: 'prepare-config',
      name: 'Validate settings',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [480, 200],
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: code([prepareConfig], 'return [{ json: prepareConfig($input.first().json, Date.now()) }];'),
      },
    },
    {
      id: 'fetch-runs',
      name: 'Fetch workflow runs',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [720, 200],
      parameters: {
        url: '={{ $json.apiUrl }}',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'githubApi',
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'per_page', value: '100' }] },
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Accept', value: 'application/vnd.github+json' },
            { name: 'X-GitHub-Api-Version', value: '2022-11-28' },
          ],
        },
        options: {
          timeout: 30000,
          response: { response: { responseFormat: 'json' } },
          pagination: {
            pagination: {
              paginationMode: 'updateAParameterInEachRequest',
              parameters: {
                parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }],
              },
              paginationCompleteWhen: 'other',
              completeExpression: '={{ $response.body.workflow_runs.length < 100 }}',
              limitPagesFetched: false,
              requestInterval: 250,
            },
          },
        },
      },
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 5000,
    },
    {
      id: 'select-alerts',
      name: 'Select new failures',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [960, 200],
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: code(
          [readSent, slackText, selectAlerts],
          "return selectAlerts($input.all().map(item => item.json), $('Validate settings').first().json, $getWorkflowStaticData('global')).map(json => ({ json }));",
        ),
      },
    },
    {
      id: 'send-slack',
      name: 'Send Slack alert',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1200, 200],
      parameters: {
        method: 'POST',
        url: 'https://slack.com/api/chat.postMessage',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'slackApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ $json.slackBody }}',
        options: {
          timeout: 30000,
          response: { response: { responseFormat: 'json' } },
          batching: { batch: { batchSize: 1, batchInterval: 1100 } },
        },
      },
    },
    {
      id: 'acknowledge-alerts',
      name: 'Confirm delivery',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1440, 200],
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: code(
          [readSent, acknowledgeAlerts],
          "return acknowledgeAlerts($input.all().map(item => item.json), $('Select new failures').all().map(item => item.json), $('Validate settings').first().json, $getWorkflowStaticData('global'));",
        ),
      },
    },
  ],
  connections: {},
  settings: {
    executionOrder: 'v1',
    executionTimeout: 240,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    saveManualExecutions: true,
    timezone: 'Etc/UTC',
  },
  pinData: {},
  tags: [],
};

for (const [source, target] of [
  ['Test manually', 'Monitor settings'],
  ['Every 5 minutes', 'Monitor settings'],
  ['Monitor settings', 'Validate settings'],
  ['Validate settings', 'Fetch workflow runs'],
  ['Fetch workflow runs', 'Select new failures'],
  ['Select new failures', 'Send Slack alert'],
  ['Send Slack alert', 'Confirm delivery'],
]) {
  workflow.connections[source] = { main: [[{ node: target, type: 'main', index: 0 }]] };
}

const file = new URL('../workflows/ci-monitor.json', import.meta.url);
const contents = `${JSON.stringify(workflow, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== contents) {
    throw new Error('Generated workflow is out of date. Run npm run build and include the JSON changes.');
  }
  console.log('Workflow matches its source.');
} else {
  await mkdir(new URL('../workflows/', import.meta.url), { recursive: true });
  await writeFile(file, contents);
  console.log('Generated workflows/ci-monitor.json');
}
