export function prepareConfig(input, now) {
  const owner = typeof input.owner === 'string' ? input.owner.trim().toLowerCase() : '';
  const repo = typeof input.repo === 'string' ? input.repo.trim().toLowerCase() : '';
  const channel = typeof input.channel === 'string' ? input.channel.trim() : '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(owner) || owner === 'your-owner') {
    throw new Error('Configure a valid GitHub owner in Monitor settings.');
  }
  if (!/^[a-z0-9_.-]{1,100}$/.test(repo) || ['.', '..', 'your-repo'].includes(repo)) {
    throw new Error('Configure a valid GitHub repository name in Monitor settings.');
  }
  if (!/^[CG][A-Z0-9]{8,}$/.test(channel) || channel === 'C0123456789') {
    throw new Error('Configure your Slack channel ID in Monitor settings, not a channel name.');
  }
  const lookbackHours = input.lookbackHours;
  if (!Number.isInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 168) {
    throw new Error('lookbackHours must be an integer from 1 to 168.');
  }
  if (!Number.isFinite(now)) {
    throw new Error('The execution timestamp is invalid.');
  }
  return {
    owner,
    repo,
    channel,
    lookbackHours,
    windowStart: now - lookbackHours * 60 * 60 * 1000,
    apiUrl: `https://api.github.com/repos/${owner}/${repo}/actions/runs`,
  };
}

export function readSent(state) {
  const sent = state.sent ?? {};
  if (typeof sent !== 'object' || sent === null || Array.isArray(sent) ||
      Object.values(sent).some((value) => !Number.isFinite(value))) {
    throw new Error('Invalid saved delivery state. Inspect workflow static data before retrying.');
  }
  return sent;
}

export function slackText(value, maxLength = 160) {
  return String(value)
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, maxLength)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function selectAlerts(pages, config, state) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('GitHub returned no response pages.');
  }
  const sent = readSent(state);
  const alerts = new Map();
  for (const page of pages) {
    if (!page || !Array.isArray(page.workflow_runs) ||
        !Number.isInteger(page.total_count) || page.total_count < 0) {
      throw new Error('Unexpected GitHub response: expected total_count and workflow_runs.');
    }
    for (const run of page.workflow_runs) {
      if (!run || typeof run.status !== 'string') {
        throw new Error('GitHub returned an invalid workflow run.');
      }
      if (run.status !== 'completed' ||
          !['failure', 'timed_out', 'startup_failure'].includes(run.conclusion)) {
        continue;
      }
      const updatedAt = Date.parse(run.updated_at);
      if (!Number.isFinite(updatedAt) || !Number.isSafeInteger(run.id) || run.id <= 0 ||
          !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
        throw new Error('A failed GitHub run is missing a valid ID, attempt, or updated_at.');
      }
      if (updatedAt < config.windowStart) continue;
      const key = `${config.owner}/${config.repo}:${config.channel}:${run.id}:${run.run_attempt}`;
      if (Object.hasOwn(sent, key)) continue;
      const runUrl = `https://github.com/${config.owner}/${config.repo}/actions/runs/${run.id}`;
      const text = [
        `GitHub Actions: ${run.conclusion}`,
        `Repository: ${slackText(config.owner)}/${slackText(config.repo)}`,
        `Workflow: ${slackText(run.name ?? '(unnamed workflow)')}`,
        `Branch: ${slackText(run.head_branch ?? '(no branch)')}`,
        `Actor: ${slackText(run.triggering_actor?.login ?? run.actor?.login ?? '(unknown)')}`,
        `Commit: ${slackText(run.head_sha ?? '(unknown)', 12)}`,
        `Run: ${run.id} | Attempt: ${run.run_attempt}`,
        `Updated: ${new Date(updatedAt).toISOString()}`,
        runUrl,
      ].join('\n');
      alerts.set(key, {
        key,
        updatedAt,
        slackBody: {
          channel: config.channel,
          text,
          mrkdwn: false,
          parse: 'none',
          link_names: false,
          unfurl_links: false,
          unfurl_media: false,
        },
      });
    }
  }
  return [...alerts.values()].sort((a, b) => a.updatedAt - b.updatedAt || a.key.localeCompare(b.key));
}

export function acknowledgeAlerts(responses, alerts, config, state) {
  if (responses.length !== alerts.length || alerts.length === 0) {
    throw new Error('Slack response count does not match the pending alerts.');
  }
  for (const response of responses) {
    if (!response || response.ok !== true || typeof response.ts !== 'string' ||
        response.channel !== config.channel) {
      const reason = response && typeof response.error === 'string' ? response.error : 'invalid response';
      throw new Error(`Slack did not confirm delivery: ${reason}. No alerts were acknowledged.`);
    }
  }
  // n8n persists static data only after a successful production execution.
  const sent = Object.fromEntries(
    Object.entries(readSent(state)).filter(([, timestamp]) => timestamp >= config.windowStart),
  );
  for (const alert of alerts) sent[alert.key] = alert.updatedAt;
  state.sent = sent;
  return [{ json: { delivered: alerts.length, channel: config.channel } }];
}
