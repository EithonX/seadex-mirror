import https from 'https';

const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

function logSuccess(msg) {
  console.log(`${colors.green}✔ ${msg}${colors.reset}`);
}

function logWarning(msg) {
  console.log(`${colors.yellow}⚠️ ${msg}${colors.reset}`);
}

function logError(msg) {
  console.error(`${colors.red}❌ ${msg}${colors.reset}`);
}

function logInfo(msg) {
  console.log(`${colors.cyan}ℹ ${msg}${colors.reset}`);
}

async function run() {
  console.log(`\n${colors.bold}${colors.blue}=== Cloudflare Pages Integration Diagnostics ===${colors.reset}\n`);

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const projectName = process.env.CLOUDFLARE_PAGES_PROJECT_NAME;

  let hasErrors = false;

  // 1. Validate CLOUDFLARE_ACCOUNT_ID
  if (!accountId) {
    logError('CLOUDFLARE_ACCOUNT_ID is missing from the environment variables.');
    hasErrors = true;
  } else {
    const trimmed = accountId.trim();
    if (trimmed !== accountId) {
      logWarning('CLOUDFLARE_ACCOUNT_ID contains leading/trailing whitespaces or newlines.');
    }
    const hexPattern = /^[0-9a-fA-F]{32}$/;
    if (!hexPattern.test(trimmed)) {
      logWarning(`CLOUDFLARE_ACCOUNT_ID does not look like a valid Cloudflare Account ID. It should be a 32-character hexadecimal string, but is currently of length ${accountId.length}.`);
    } else {
      logSuccess(`CLOUDFLARE_ACCOUNT_ID format is valid (32-character hex).`);
    }
  }

  // 2. Validate CLOUDFLARE_API_TOKEN
  if (!apiToken) {
    logError('CLOUDFLARE_API_TOKEN is missing from the environment variables.');
    hasErrors = true;
  } else {
    const trimmed = apiToken.trim();
    if (trimmed !== apiToken) {
      logWarning('CLOUDFLARE_API_TOKEN contains leading/trailing whitespaces or newlines. This will cause authentication to fail.');
    }
    // Standard Cloudflare API tokens are 40 characters long.
    if (trimmed.length !== 40) {
      logWarning(`CLOUDFLARE_API_TOKEN is ${trimmed.length} characters long. Standard Cloudflare API tokens are usually 40 characters long. Please verify you didn't accidentally copy the 'Token ID' (which is a 32-character hexadecimal string) instead of the actual secret token value.`);
    } else {
      logSuccess(`CLOUDFLARE_API_TOKEN length matches standard format (40 characters).`);
    }
  }

  // 3. Validate CLOUDFLARE_PAGES_PROJECT_NAME
  if (!projectName) {
    logWarning('CLOUDFLARE_PAGES_PROJECT_NAME is missing or empty. Defaulting to "seadex".');
  } else {
    logSuccess(`CLOUDFLARE_PAGES_PROJECT_NAME is set to: "${projectName}".`);
  }

  if (hasErrors) {
    console.log(`\n${colors.red}Diagnostics failed due to missing required configuration. Please check your GitHub repository secrets.${colors.reset}\n`);
    process.exit(1);
  }

  const finalAccountId = (accountId || '').trim();
  const finalApiToken = (apiToken || '').trim();
  const finalProjectName = (projectName || 'seadex').trim();

  logInfo(`Connecting to Cloudflare API to check access to project "${finalProjectName}"...`);

  try {
    const response = await checkCloudflareAccess(finalAccountId, finalApiToken, finalProjectName);
    if (response.statusCode === 200 && response.body.success) {
      logSuccess('Successfully authenticated with Cloudflare and verified Pages project access!');
      console.log(`\n${colors.green}🎉 Everything is configured correctly! Cloudflare Pages deployment can proceed.${colors.reset}\n`);
      process.exit(0);
    } else {
      handleApiFailure(response.statusCode, response.body, finalAccountId, finalApiToken);
      process.exit(1);
    }
  } catch (err) {
    logError(`Network or request error: ${err.message}`);
    process.exit(1);
  }
}

function checkCloudflareAccess(accountId, token, projectName) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      port: 443,
      path: `/client/v4/accounts/${accountId}/pages/projects/${projectName}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: { raw: data, error: 'Failed to parse JSON response' } });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

function handleApiFailure(statusCode, body, accountId, token) {
  logError(`Cloudflare Pages access check failed.`);
  console.log(`${colors.bold}HTTP Status Code:${colors.reset} ${statusCode}`);
  console.log(`${colors.bold}Response Payload:${colors.reset}`);
  console.log(JSON.stringify(body, null, 2));

  console.log(`\n${colors.bold}${colors.yellow}💡 Actionable Troubleshooting Checklist:${colors.reset}`);

  const errors = body.errors || [];
  const hasAuthError = errors.some(e => e.code === 9106 || e.message?.toLowerCase().includes('auth') || statusCode === 400 || statusCode === 401 || statusCode === 403);

  if (hasAuthError) {
    console.log(`
1. ${colors.bold}Check for leading/trailing whitespaces/newlines:${colors.reset}
   When copy-pasting values into GitHub Secrets, it's very easy to accidentally copy a leading space or trailing newline.
   Go to your GitHub repository Settings -> Secrets and variables -> Actions, update the secrets:
   - ${colors.bold}CLOUDFLARE_API_TOKEN${colors.reset} (ensure there are NO spaces or line breaks)
   - ${colors.bold}CLOUDFLARE_ACCOUNT_ID${colors.reset} (ensure there are NO spaces or line breaks)

2. ${colors.bold}Verify API Token vs. Token ID:${colors.reset}
   Your token has a secret value (usually 40 characters long) that is only shown ONCE when you create it.
   If your token value looks like a 32-character hex string (similar to the account ID), you might have copied the ${colors.bold}Token ID${colors.reset} instead of the actual ${colors.bold}API Token secret value${colors.reset}.
   Please create a new API Token in the Cloudflare Dashboard and copy the secret value shown at the end.

3. ${colors.bold}Verify API Token Permissions:${colors.reset}
   Ensure the API Token has the correct permissions configured under Account-level permissions:
   - Account -> Cloudflare Pages -> Edit (or both Pages Read and Pages Write)
   If the token only has permissions scoped to a specific zone (like Zone.DNS), it will fail to access Pages.
   To check/fix this:
   - Go to your Cloudflare Dashboard -> My Profile -> API Tokens.
   - Edit your token and ensure it has "Account" resources selected, and "Cloudflare Pages" is set to "Edit" (or Read/Write).

4. ${colors.bold}Verify Account ID:${colors.reset}
   Ensure that the ${colors.bold}CLOUDFLARE_ACCOUNT_ID${colors.reset} in GitHub exactly matches the Account ID shown in your Cloudflare dashboard URL:
   Your dashboard URL is:
   https://dash.cloudflare.com/9b835160d03574cff1f5cef7e70bdcd0/...
   This means your Account ID is ${colors.bold}9b835160d03574cff1f5cef7e70bdcd0${colors.reset}. Please make sure your secret exactly matches this value.
`);
  } else {
    console.log(`
1. Verify that the project name "${process.env.CLOUDFLARE_PAGES_PROJECT_NAME || 'seadex'}" exists under your Cloudflare account.
2. Check if the project name has any typos.
`);
  }
}

run();
