const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 15000;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBaseUrl() {
  const explicit = (process.env.DEPLOYED_SITE_URL || '').trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  const project = (process.env.CLOUDFLARE_PAGES_PROJECT_NAME || '').trim() || 'seadex';
  return `https://${project}.pages.dev`.replace(/\/+$/, '');
}

async function fetchOnce(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return { response, text };
}

// Retry the whole check (network errors AND validation failures) up to
// MAX_ATTEMPTS, so slow post-deploy propagation does not fail the run.
async function retryCheck(label, checkFn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await checkFn();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        logWarning(`Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${label}: ${lastError}. Retrying in ${RETRY_DELAY_MS} ms...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

function parseJsonSafe(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

async function checkHtmlRoute(baseUrl, path, failures) {
  const url = `${baseUrl}${path}`;
  try {
    await retryCheck(path, async () => {
      const { response, text } = await fetchOnce(url);
      const contentType = response.headers.get('content-type') || '';

      if (response.status !== 200) {
        throw new Error(`expected HTTP 200, got ${response.status}.`);
      }
      if (!contentType.includes('text/html')) {
        throw new Error(`expected text/html content-type, got "${contentType}".`);
      }
      if (!text.includes('SeaDex') && !text.includes('id="app"')) {
        throw new Error('app shell marker not found in HTML body.');
      }
    });
  } catch (err) {
    failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    logError(`${path} failed HTML check.`);
    return;
  }

  logSuccess(`${path} serves the app shell (HTTP 200, text/html).`);
}

async function checkJsonRoute(baseUrl, path, validate, failures, cacheState) {
  const url = `${baseUrl}${path}`;
  let response;
  try {
    response = await retryCheck(path, async () => {
      const result = await fetchOnce(url);
      const contentType = result.response.headers.get('content-type') || '';

      if (result.response.status !== 200) {
        throw new Error(`expected HTTP 200, got ${result.response.status}.`);
      }

      const parsed = parseJsonSafe(result.text);
      const looksJson = contentType.includes('application/json') || parsed.ok;
      if (!looksJson || !parsed.ok) {
        throw new Error(`response did not parse as JSON (content-type "${contentType}").`);
      }

      const validationError = validate(parsed.value);
      if (validationError) {
        throw new Error(validationError);
      }

      return result.response;
    });
  } catch (err) {
    failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    logError(`${path} failed JSON check.`);
    return;
  }

  // Cache-control observation (non-fatal per route), only after a valid response.
  cacheState.total += 1;
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) {
    cacheState.withCacheControl += 1;
  } else {
    logWarning(`${path} is missing a Cache-Control header.`);
  }

  logSuccess(`${path} serves valid JSON.`);
}

async function main() {
  const baseUrl = getBaseUrl();
  console.log('=== Deployed Site Smoke Verification ===');
  logInfo(`Base URL: ${baseUrl}`);

  const failures = [];
  const cacheState = { total: 0, withCacheControl: 0 };

  const htmlRoutes = ['/', '/about', '/sheet'];
  for (const path of htmlRoutes) {
    await checkHtmlRoute(baseUrl, path, failures);
  }

  await checkJsonRoute(
    baseUrl,
    '/mirror-data/status.json',
    (data) => (data && typeof data === 'object' && !Array.isArray(data) ? null : 'expected a JSON object.'),
    failures,
    cacheState,
  );
  await checkJsonRoute(
    baseUrl,
    '/mirror-data/catalog.json',
    (data) => (data && Array.isArray(data.items) ? null : 'expected an "items" array.'),
    failures,
    cacheState,
  );
  await checkJsonRoute(
    baseUrl,
    '/mirror-data/sheet-workbook.json',
    (data) => (data && Array.isArray(data.sheets) ? null : 'expected a "sheets" array.'),
    failures,
    cacheState,
  );

  // Fail only if Cache-Control is obviously absent on ALL JSON routes.
  if (cacheState.total > 0 && cacheState.withCacheControl === 0) {
    failures.push('Cache-Control header is missing on all JSON routes.');
    logError('No JSON route returned a Cache-Control header.');
  }

  console.log('');
  if (failures.length > 0) {
    logError(`Smoke verification failed with ${failures.length} issue(s):`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  logSuccess('All deployed-site smoke checks passed.');
  process.exit(0);
}

main();
