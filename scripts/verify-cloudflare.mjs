import https from 'node:https';

const REQUEST_TIMEOUT_MS = 15000;
const HEX_32 = /^[0-9a-fA-F]{32}$/;

function logInfo(msg) {
  console.log(`INFO: ${msg}`);
}

function logSuccess(msg) {
  console.log(`OK: ${msg}`);
}

function logWarning(msg) {
  console.log(`WARN: ${msg}`);
}

function logError(msg) {
  console.error(`ERROR: ${msg}`);
}

function getEnvConfig() {
  const rawAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const rawApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const rawProjectName = process.env.CLOUDFLARE_PAGES_PROJECT_NAME;

  const errors = [];

  // Account ID
  const accountId = (rawAccountId || '').trim();
  if (rawAccountId === undefined) {
    errors.push('CLOUDFLARE_ACCOUNT_ID is missing from the environment.');
  } else if (accountId === '') {
    errors.push('CLOUDFLARE_ACCOUNT_ID is empty.');
  } else {
    if (accountId !== rawAccountId) {
      logWarning('CLOUDFLARE_ACCOUNT_ID has leading/trailing whitespace or newlines.');
    }
    if (!HEX_32.test(accountId)) {
      logWarning('CLOUDFLARE_ACCOUNT_ID does not look like a 32-character hex Account ID. The API check below is the source of truth.');
    }
  }

  // API token
  const apiToken = (rawApiToken || '').trim();
  if (rawApiToken === undefined) {
    errors.push('CLOUDFLARE_API_TOKEN is missing from the environment.');
  } else if (apiToken === '') {
    errors.push('CLOUDFLARE_API_TOKEN is empty.');
  } else {
    if (apiToken !== rawApiToken) {
      logWarning('CLOUDFLARE_API_TOKEN has leading/trailing whitespace or newlines.');
    }
    if (HEX_32.test(apiToken)) {
      logWarning('CLOUDFLARE_API_TOKEN looks like a 32-character hex Token ID. Verify you copied the secret token value, not the Token ID.');
    }
  }

  // Project name
  let projectName = (rawProjectName || '').trim();
  if (rawProjectName !== undefined && projectName !== rawProjectName) {
    logWarning('CLOUDFLARE_PAGES_PROJECT_NAME has leading/trailing whitespace or newlines.');
  }
  if (projectName === '') {
    projectName = 'seadex';
    logInfo('CLOUDFLARE_PAGES_PROJECT_NAME is missing or empty. Defaulting to "seadex".');
  }

  return { accountId, apiToken, projectName, errors };
}

function requestCloudflareProject(accountId, apiToken, projectName) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      port: 443,
      path: `/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, rawBody: data });
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS} ms.`));
    });

    req.on('error', reject);
    req.end();
  });
}

function parseJsonResponse(rawBody) {
  try {
    return { ok: true, body: JSON.parse(rawBody) };
  } catch {
    return { ok: false, body: null };
  }
}

function printFailure(statusCode, body, rawBody, projectName) {
  logError('Cloudflare Pages access check failed.');
  console.log(`HTTP status: ${statusCode}`);
  console.log(`Project checked: "${projectName}"`);

  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    console.log('Cloudflare errors:');
    for (const e of body.errors) {
      const code = e && e.code !== undefined ? e.code : 'unknown';
      const message = e && e.message ? e.message : 'no message';
      console.log(`  - [${code}] ${message}`);
    }
  } else if (!body) {
    const preview = (rawBody || '').slice(0, 200).replace(/\s+/g, ' ').trim();
    console.log(`Response preview: ${preview || '(empty)'}`);
  }

  console.log('');
  console.log('Troubleshooting:');
  console.log('  1. Verify CLOUDFLARE_ACCOUNT_ID belongs to the account that owns the Pages project.');
  console.log('  2. Verify the API token has Account / Cloudflare Pages permissions (Read or Edit).');
  console.log('  3. Verify the Pages project name exists under that account.');
  console.log('  4. Verify you copied the API token secret value, not the Token ID.');
}

async function main() {
  console.log('=== Cloudflare Pages Integration Diagnostics ===');

  const { accountId, apiToken, projectName, errors } = getEnvConfig();

  if (errors.length > 0) {
    for (const err of errors) {
      logError(err);
    }
    logError('Diagnostics failed due to missing required configuration. Check your repository secrets.');
    process.exit(1);
  }

  logInfo(`Checking access to Pages project "${projectName}"...`);

  let response;
  try {
    response = await requestCloudflareProject(accountId, apiToken, projectName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Network or request error: ${message}`);
    process.exit(1);
  }

  const { ok, body } = parseJsonResponse(response.rawBody);

  if (response.statusCode === 200 && ok && body && body.success === true) {
    logSuccess('Authenticated with Cloudflare and verified Pages project access.');
    process.exit(0);
  }

  printFailure(response.statusCode, ok ? body : null, response.rawBody, projectName);
  process.exit(1);
}

main();
